import fs = require('fs');
import path = require('path');
import tl = require('vsts-task-lib/task');
import glob = require('glob');
import bb = require('bluebird');
import Q = require('q');
let google = require('googleapis');
let apkParser = require('node-apk-parser');
let publisher = google.androidpublisher('v2');

interface ClientKey {
    client_email?: string;
    private_key?: string;
}

interface AndroidResource {
    track?: string;
    versionCodes?: any;
    userFraction?: number;
    language?: string;
    recentChanges?: string;
}

interface AndroidMedia {
    body: fs.ReadStream;
    mimeType: string;
}

interface PackageParams {
    packageName?: string;
    editId?: any;
    track?: string;
    resource?: AndroidResource;
    media?: AndroidMedia;
    apkVersionCode?: number;
    language?: string;
    imageType?: string;
    uploadType?: string;
}

interface GlobalParams {
    auth?: any;
    params?: PackageParams;
}

interface Edit {
    id: string;
    expiryTimeSeconds: string;
}

interface Apk {
  versionCode: number;
  binary: {
    sha1: string;
  };
}

interface Track {
  track: string;
  versionCodes: number[];
  userFraction: number;
}

async function run() {
    try {
        tl.setResourcePath(path.join(__dirname, 'task.json'));
        let authType: string = tl.getInput('authType', true);
        let key: ClientKey = {};
        if (authType === 'JsonFile') {
            let serviceAccountKeyFile: string = tl.getPathInput('serviceAccountKey', false);
            if (!serviceAccountKeyFile) {
                throw new Error(tl.loc('JsonKeyFileNotFound'));
            }
            let stats: fs.Stats = fs.statSync(serviceAccountKeyFile);
            if (stats && stats.isFile()) {
                key = require(serviceAccountKeyFile);
            } else {
                console.error(tl.loc('InvalidAuthFile'));
                throw new Error(tl.loc('InvalidAuthFilewithName', serviceAccountKeyFile));
            }
        } else if (authType === 'ServiceEndpoint') {
            let serviceEndpoint: tl.EndpointAuthorization = tl.getEndpointAuthorization(tl.getInput('serviceEndpoint', true), true);
            if (!serviceEndpoint) {
                throw new Error(tl.loc('EndpointNotFound'));
            }
            key.client_email = serviceEndpoint.parameters['username'];
            key.private_key = serviceEndpoint.parameters['password'].replace(/\\n/g, '\n');
        }

        let apkFile: string = resolveGlobPath(tl.getPathInput('apkFile', true));
        let apkFileList: string[] = [apkFile];
        let additionalApks: string[] = tl.getDelimitedInput('additionalApks', '\n');
        if (additionalApks.length > 0) {
            for (let i = 0; i < additionalApks.length; i++) {
                apkFileList.push(resolveGlobPath(additionalApks[i]));
            }
            console.log(tl.loc('FoundMultiApks'));
            console.log(apkFileList);
        }

        let track: string = tl.getInput('track', true);
        let userFraction: number = Number(tl.getInput('userFraction', false)); // Used for staged rollouts
        let changelogFile: string = tl.getInput('changelogFile', false);
        let shouldAttachMetadata: any = JSON.parse(tl.getInput('shouldAttachMetadata', false));

        // Constants
        let GOOGLE_PLAY_SCOPES: string[] = ['https://www.googleapis.com/auth/androidpublisher'];
        let APK_MIME_TYPE: string = 'application/vnd.android.package-archive';

        let globalParams: GlobalParams = { auth: null, params: {} };
        let apkVersionCodes: any = [];

        // The submission process is composed
        // of a transction with the following steps:
        // -----------------------------------------
        // #1) Extract the package name from the specified APK file
        // #2) Get an OAuth token by authentincating the service account
        // #3) Create a new editing transaction
        // #4) Upload the new APK(s)
        // #5) Specify the track that should be used for the new APK (e.g. alpha, beta)
        // #6) Specify the new change log
        // #7) Commit the edit transaction

        let packageName: string = tryGetPackageName(apkFile);
        updateGlobalParams(globalParams, 'packageName', packageName);

        let jwtClient: any = new google.auth.JWT(key.client_email, null, key.private_key, GOOGLE_PLAY_SCOPES, null);
        await jwtClient.authorizeAsync();
        globalParams.auth = jwtClient;

        let edits: any = publisher.edits;
        [edits, edits.apklistings, edits.apks, edits.tracks, edits.listings, edits.images, jwtClient].forEach(bb.promisifyAll);

        console.log(tl.loc('GetNewEditAfterAuth'));
        let currentEdit: Edit = await getNewEdit(edits, globalParams, packageName);
        updateGlobalParams(globalParams, 'editId', currentEdit.id);

        apkFileList.forEach(async (apkFile) => {
            let apk: Apk = await addApk(edits, packageName, apkFile, APK_MIME_TYPE);

            tl.debug(`Uploaded version code ${apk.versionCode}`);
            apkVersionCodes.push(apk.versionCode);
        });

        console.log(tl.loc('UpdateTrack'));
        let updatedTrack: Track = await updateTrack(edits, packageName, track, apkVersionCodes, userFraction);
        tl.debug(`Updated layout ${JSON.stringify(updatedTrack)}`);

        if (shouldAttachMetadata) {
            let metadataRootPath: string = tl.getInput('metadataRootPath', true);

            console.log(tl.loc('AttachingMetadataToRelease'));
            await addMetadata(edits, apkVersionCodes, changelogFile, metadataRootPath);
        }

        tl.debug('Upload change logs if specified...');
        await uploadChangeLogs(edits, changelogFile, apkVersionCodes);

        edits.commitAsync()
        .then(res => {
            console.log(tl.loc('AptPublishSucceed'));
            console.log(tl.loc('TrackInfo', track));
            tl.setResult(tl.TaskResult.Succeeded, tl.loc('Success'));
        }).catch( err => {
            tl.error(err);
            tl.setResult(tl.TaskResult.Failed, tl.loc('Failure'));
        });
    } catch (err) {
        tl.setResult(tl.TaskResult.Failed, err);
    }
}

/**
 * Tries to extract the package name from an apk file
 * @param {Object} apkFile The apk file from which to attempt name extraction
 * @return {string} packageName Name extracted from package. null if extraction failed
 */
function tryGetPackageName(apkFile): string {
    tl.debug('Candidate package: ' + apkFile);

    let packageName: string;

    try {
        packageName = apkParser
            .readFile(apkFile)
            .readManifestSync()
            .package;

        tl.debug(`name extraction from apk succeeded: ${packageName}`);
    } catch (e) {
        tl.debug(`name extraction from apk failed: ${e}`);
        throw new Error(`The specified APK file ${apkFile} is not valid. Please check the path and try to queue another build.`);
    }

    return packageName;
}

/**
 * Uses the provided JWT client to request a new edit from the Play store and attach the edit id to all requests made this session
 * Assumes authorized
 * @param {string} packageName unique android package name (com.android.etc)
 * @return {Promise} edit A promise that will return result from inserting a new edit
 *                          { id: string, expiryTimeSeconds: string }
 */
function getNewEdit(edits: any, globalParams: GlobalParams, packageName: string): Q.Promise<Edit> {
    tl.debug('Creating a new edit');
    let defer = Q.defer<Edit>();

    let requestParameters: PackageParams = {
        packageName: packageName
    };
    tl.debug('Additional Parameters: ' + JSON.stringify(requestParameters));

    edits.insertAsync(requestParameters)
    .then(res => defer.resolve(res[0]))
    .catch(err => {
        tl.debug(err);
        throw new Error(`Failed to create a new edit transaction for the package ${packageName}. See log for details.`);
    });

    return defer.promise;
}

/**
 * Adds an apk to an existing edit
 * Assumes authorized
 * @param {string} packageName unique android package name (com.android.etc)
 * @param {string} apkFile path to apk file
 * @returns {Promise} apk A promise that will return result from uploading an apk
 *                          { versionCode: integer, binary: { sha1: string } }
 */
function addApk(edits: any, packageName: string, apkFile: string, APK_MIME_TYPE: string): Q.Promise<Apk> {
    tl.debug('Uploading a new apk: ' + apkFile);
    let defer = Q.defer<Apk>();

    let requestParameters: PackageParams = {
        packageName: packageName,
        media: {
            body: fs.createReadStream(apkFile),
            mimeType: APK_MIME_TYPE
        }
    };
    tl.debug('Additional Parameters: ' + JSON.stringify(requestParameters));

    edits.apks.uploadAsync(requestParameters)
    .then(res => defer.resolve(res[0]))
    .catch(err => {
        tl.debug(err);
        throw new Error(`Failed to upload the APK ${apkFile}. See log for details.`);
    });

    return defer.promise;
}

/**
 * Update a given release track with the given information
 * Assumes authorized
 * @param {string} packageName unique android package name (com.android.etc)
 * @param {string} track one of the values {"alpha", "beta", "production", "rollout"}
 * @param {(number|number[])} versionCode version code returned from an apk call. will take either a number or a number[]
 * @param {double} userFraction for rollout, fraction of users to get update
 * @returns {Promise} track A promise that will return result from updating a track
 *                            { track: string, versionCodes: [integer], userFraction: double }
 */
function updateTrack(edits: any, packageName: string, track: string, versionCode: any, userFraction: number): Q.Promise<Track> {
    tl.debug('Updating track');
    let defer = Q.defer<Track>();

    let requestParameters: PackageParams = {
        packageName: packageName,
        track: track,
        resource: {
            track: track,
            versionCodes: (typeof versionCode === 'number' ? [versionCode] : versionCode)
        }
    };

    if (track === 'rollout') {
        requestParameters.resource.userFraction = userFraction;
    }

    tl.debug('Additional Parameters: ' + JSON.stringify(requestParameters));

    edits.tracks.updateAsync(requestParameters)
    .then(res => defer.resolve(res[0]))
    .catch(err => {
        tl.debug(err);
        throw new Error(`Failed to update track ${track}}). See log for details.`);
    });

    return defer.promise;
}

/**
 * Uploads change log files if specified for all the apk version codes in the update
 * @param changelogFile
 * @param apkVersionCodes
 * @returns {*}
 */
function uploadChangeLogs(edits: any, changelogFile: string, apkVersionCodes: number[]) {
    let stats: fs.Stats = fs.statSync(changelogFile);

    if (stats && stats.isFile()) {
        apkVersionCodes.forEach(async (apkVersionCode) => {
            await addChangelog(edits, 'en-US', changelogFile, apkVersionCode);
        });
    } else {
        throw new Error(`No changelog file ${changelogFile} found.`);
    }
}

/**
 * Add a changelog to an edit
 * Assumes authorized
 * @param {string} languageCode Language code (a BCP-47 language tag) of the localized listing to update
 * @param {string} changelogFile Path to changelog file.
 * @param {integer} APK version code
 * @returns {Promise} track A promise that will return result from updating a track
 *                            { track: string, versionCodes: [integer], userFraction: double }
 */
function addChangelog(edits: any, languageCode: string, changelogFile: string, apkVersionCode: number) {
    tl.debug(`Adding the changelog file ${changelogFile} to the APK version code ${apkVersionCode}`);

    let changelog: string;
    try {
        changelog = fs.readFileSync(changelogFile).toString();
    } catch (e) {
        tl.debug(e);
        tl.debug(`Most likely failed to read the specified changelog.`);
        throw new Error(`Changelog reading failed for log ${changelogFile}. Check logs for details.`);
    }

    let requestParameters: PackageParams = {
        apkVersionCode: apkVersionCode,
        language: languageCode,
        resource: {
            language: languageCode,
            recentChanges: changelog
        }
    };
    tl.debug('Additional Parameters: ' + JSON.stringify(requestParameters));

    edits.apklistings.updateAsync(requestParameters)
    .catch(err => {
        tl.debug(err);
        throw new Error(`Failed to upload the changelog ${changelogFile}. See log for details.`);
    });
}

/**
 * Adds all changelogs found in directory to an edit. Pulls version code from file name. Failing this, assumes the global version code inferred from apk
 * Assumes authorized
 * @param {string} languageCode Language code (a BCP-47 language tag) of the localized listing to update
 * @param {string} directory Directory with a changesogs folder where changelogs can be found.
 * @returns {Promise} track A promise that will return result from updating an apk listing
 *                            { language: string, recentChanges: string }
 */
function addAllChangelogs(edits: any, changelogFile: string, apkVersionCodes: any, languageCode: string, directory: string) {
    let changelogDir: string = path.join(directory, 'changelogs');

    let changelogs: string[] = fs.readdirSync(changelogDir).filter(subPath => {
        try {
            let fileToCheck: string = path.join(changelogDir, subPath);
            tl.debug(`Checking File ${fileToCheck}`);
            return fs.statSync(fileToCheck).isFile();
        } catch (e) {
            tl.debug(e);
            tl.debug(`Failed to stat path ${subPath}. Ignoring...`);
            return false;
        }
    });

    if (changelogs.length === 0) {
        return;
    }

    let versionCodeFound: boolean = false;
    changelogs.forEach(async (changelogFile) => {
        let changelogName: string = path.basename(changelogFile, path.extname(changelogFile));
        let changelogVersion: number = parseInt(changelogName, 10);
        if (apkVersionCodes.indexOf(changelogVersion) === -1) {
            tl.debug(`File ${changelogFile} is not a valid version code`);
            return;
        }

        versionCodeFound = true;
        let fullChangelogPath: string = path.join(changelogDir, changelogFile);
        console.log(tl.loc('AppendChangelog', fullChangelogPath));
        await addChangelog.bind(this, edits, languageCode, fullChangelogPath, changelogVersion)();
    });

    if (versionCodeFound) {
        return;
    }

    if (changelogs.length === 1) {
        tl.debug(`Applying file ${changelogFile} to all version codes`);
        let fullChangelogPath: string = path.join(changelogDir, changelogs[0]);
        apkVersionCodes.forEach(async (apkVersionCode) => {
            console.log(tl.loc('AppendChangelog', fullChangelogPath));
            await addChangelog(edits, languageCode, fullChangelogPath, apkVersionCode);
        });
    }
}

/**
 * Attaches the metadata in the specified directory to the edit. Assumes the metadata structure specified by Fastlane.
 * Assumes authorized
 *
 * Metadata Structure:
 * metadata
 *  └ $(languageCodes)
 *    ├ full_description.txt
 *    ├ short_description.txt
 *    ├ title.txt
 *    ├ video.txt
 *    ├ images
 *    |  ├ featureGraphic.png    || featureGraphic.jpg   || featureGraphic.jpeg
 *    |  ├ icon.png              || icon.jpg             || icon.jpeg
 *    |  ├ promoGraphic.png      || promoGraphic.jpg     || promoGraphic.jpeg
 *    |  ├ tvBanner.png          || tvBanner.jpg         || tvBanner.jpeg
 *    |  ├ phoneScreenshots
 *    |  |  └ *.png || *.jpg || *.jpeg
 *    |  ├ sevenInchScreenshots
 *    |  |  └ *.png || *.jpg || *.jpeg
 *    |  ├ tenInchScreenshots
 *    |  |  └ *.png || *.jpg || *.jpeg
 *    |  ├ tvScreenshots
 *    |  |  └ *.png || *.jpg || *.jpeg
 *    |  └ wearScreenshots
 *    |     └ *.png || *.jpg || *.jpeg
 *    └ changelogs
 *      └ $(versioncodes).txt
 *
 * @param {string} metadataRootDirectory Path to the folder where the Fastlane metadata structure is found. eg the folders under this directory should be the language codes
 * @returns {Promise}  A promise that will return the result from last metadata change that was attempted. Currently, this is most likely an image upload.
 *                     { image: { id: string, url: string, sha1: string } }
 */
function addMetadata(edits: any, apkVersionCodes: number[], changelogFile: string, metadataRootDirectory: string) {
    tl.debug('Attempting to add metadata...');
    tl.debug(`Adding metadata from ${metadataRootDirectory}`);

    let metadataLanguageCodes: string[] = fs.readdirSync(metadataRootDirectory).filter((subPath) => {
        try {
            return fs.statSync(path.join(metadataRootDirectory, subPath)).isDirectory();
        } catch (e) {
            tl.debug(e);
            tl.debug(`Failed to stat path ${subPath}. Ignoring...`);
            return false;
    }});

    metadataLanguageCodes.forEach(async (languageCode) =>  {
        let nextDir: string = path.join(metadataRootDirectory, languageCode);
        tl.debug(`Processing metadata for language code ${languageCode}`);
        await uploadMetadataWithLanguageCode(edits, apkVersionCodes, changelogFile, languageCode, nextDir);
    });
}

/**
 * Updates the details for a language with new information
 * Assumes authorized
 * @param {string} languageCode Language code (a BCP-47 language tag) of the localized listing to update
 * @param {string} directory Directory where updated listing details can be found.
 * @returns {Promise} A Promise that will return after all metadata updating operations are completed.
 */
async function uploadMetadataWithLanguageCode(edits: any, apkVersionCodes: number[], changelogFile: string, languageCode: string, directory: string) {
    console.log(tl.loc('UploadingMetadataForLanguage', directory, languageCode));

    let patchListingRequestParameters: PackageParams = {
        language: languageCode
    };

    patchListingRequestParameters.resource = createPatchListingResource(languageCode, directory);
    await edits.listings.patchAsync(patchListingRequestParameters);

    await addAllChangelogs(edits, changelogFile, apkVersionCodes, languageCode, directory);

    await attachImages(edits, languageCode, directory);
}

/**
 * Helper method for creating the resource for the edits.listings.patch method.
 * @param {string} languageCode Language code (a BCP-47 language tag) of the localized listing to update
 * @param {string} directory Directory where updated listing details can be found.
 * @returns {Object} resource A crafted resource for the edits.listings.patch method.
 *                              { languageCode: string, fullDescription: string, shortDescription: string, title: string, video: string }
 */
function createPatchListingResource(languageCode: string, directory: string) { // TODO: the interface here is wrong!
    tl.debug(`Constructing resource to patch listing with language code ${languageCode} from ${directory}`);
    let resourceParts = {
        fullDescription: 'full_description.txt',
        shortDescription: 'short_description.txt',
        title: 'title.txt',
        video: 'video.txt'
    };

    let resource = {
        language: languageCode
    };

    for (let i in resourceParts) {
        if (resourceParts.hasOwnProperty(i)) {
            let file: string = path.join(directory, resourceParts[i]);
            // let fileContents;
            try {
                let fileContents: Buffer = fs.readFileSync(file);
                resource[i] = fileContents.toString();
            } catch (e) {
                tl.debug(`Failed to read metadata file ${file}. Ignoring...`);
            }
        }
    }

    tl.debug(`Finished constructing resource ${JSON.stringify(resource)}`);
    return resource;
}

/**
 * Upload images to the app listing.
 * Assumes authorized
 * @param {string} languageCode Language code (a BCP-47 language tag) of the localized listing to update
 * @param {string} directory Directory where updated listing details can be found.
 * @returns {Promise} response Response from last attempted image upload
 *                             { image: { id: string, url: string, sha1: string } }
 */
async function attachImages(edits: any, languageCode: string, directory: string) {
    tl.debug(`Starting upload of images with language code ${languageCode} from ${directory}`);

    let imageList: any = getImageList(directory);

    for (let imageType in imageList) {
        if (imageList.hasOwnProperty(imageType)) {
            let images: any = imageList[imageType];
            for (let i in images) {
                if (images.hasOwnProperty(i)) {
                    await uploadImage(edits, languageCode, imageType, images[i]);
                }
            }
        }
    }

    tl.debug(`All images uploaded`);
}

/**
 * Get all the images in the metadata directory that need to be uploaded.
 * Assumes all files are in a folder labeled "images" at the root of directory
 * directory
 *  └ images
 *    ├ featureGraphic.png    || featureGraphic.jpg   || featureGraphic.jpeg
 *    ├ icon.png              || icon.jpg             || icon.jpeg
 *    ├ promoGraphic.png      || promoGraphic.jpg     || promoGraphic.jpeg
 *    ├ tvBanner.png          || tvBanner.jpg         || tvBanner.jpeg
 *    ├ phoneScreenshots
 *    |  └ *.png || *.jpg || *.jpeg
 *    ├ sevenInchScreenshots
 *    |  └ *.png || *.jpg || *.jpeg
 *    ├ tenInchScreenshots
 *    |  └ *.png || *.jpg || *.jpeg
 *    ├ tvScreenshots
 *    |  └ *.png || *.jpg || *.jpeg
 *    └ wearScreenshots
 *       └ *.png || *.jpg || *.jpeg
 * @param {string} directory Directory where the "images" folder is found matching the structure specified above
 * @returns {Object} imageList Map of image types to lists of images matching that type.
 *                              { [imageType]: string[] }
 */
function getImageList(directory: string): any {
    let imageTypes: string[] = ['featureGraphic', 'icon', 'promoGraphic', 'tvBanner', 'phoneScreenshots', 'sevenInchScreenshots', 'tenInchScreenshots', 'tvScreenshots', 'wearScreenshots'];
    let acceptedExtensions: string[] = ['.png', '.jpg', '.jpeg'];

    let imageDirectory: string = path.join(directory, 'images');
    let imageList: any = {};

    for (let i = 0; i < imageTypes.length; i++) {
        let shouldAttemptUpload: boolean = false;
        let imageType: string = imageTypes[i];

        imageList[imageType] = [];

        tl.debug(`Attempting to get images of type ${imageType}`);
        switch (imageType) {
            case 'featureGraphic':
            case 'icon':
            case 'promoGraphic':
            case 'tvBanner':
                for (let i = 0; i < acceptedExtensions.length && !shouldAttemptUpload; i++) {
                    let fullPathToFileToCheck: string = path.join(imageDirectory, imageType + acceptedExtensions[i]);
                    try {
                        let imageStat: fs.Stats = fs.statSync(fullPathToFileToCheck);
                        if (imageStat) {
                            shouldAttemptUpload = imageStat.isFile();
                            if (shouldAttemptUpload) {
                                console.log(tl.loc('FoundImageAtPath', imageType, fullPathToFileToCheck));
                                imageList[imageType].push(fullPathToFileToCheck);
                                break;
                            }
                        }
                    } catch (e) {
                        tl.debug(`File ${fullPathToFileToCheck} doesn't exist. Skipping...`);
                    }
                }

                if (!shouldAttemptUpload) {
                    console.log(tl.loc('ImageTypeNotFound', imageType));
                }
                break;
            case 'phoneScreenshots':
            case 'sevenInchScreenshots':
            case 'tenInchScreenshots':
            case 'tvScreenshots':
            case 'wearScreenshots':
                try {
                    let fullPathToDirToCheck: string = path.join(imageDirectory, imageType);
                    let imageStat: fs.Stats = fs.statSync(fullPathToDirToCheck);
                    if (imageStat) {
                        tl.debug(`Found something for type ${imageType}`);
                        shouldAttemptUpload = imageStat.isDirectory();
                        if (!shouldAttemptUpload) {
                            console.log(tl.loc('StatNotDirectory', imageType));
                        } else {
                            imageList[imageType] = fs.readdirSync(fullPathToDirToCheck)
                                .filter(function (image) {
                                    let pathIsFile = false;
                                    try {
                                        pathIsFile = fs.statSync(path.join(fullPathToDirToCheck, image)).isFile();
                                    } catch (e) {
                                        tl.debug(e);
                                        tl.debug(`Failed to stat path ${image}. Ignoring...`);
                                    }

                                    return pathIsFile;
                                })
                                .map(function (image) {
                                    return path.join(fullPathToDirToCheck, image);
                                });
                        }
                    }
                } catch (e) {
                    tl.debug(e);
                    console.log(tl.loc('ImageDirNotFound', imageType));
                }
                break;
            default:
                tl.debug(`Image type ${imageType} is an unknown type and was ignored`);
                continue;
        }
    }

    tl.debug(`Finished enumerating images: ${JSON.stringify(imageList)}`);
    return imageList;
}

/**
 * Attempts to upload the specified image to the edit
 * Assumes authorized
 * @param {string} languageCode Language code (a BCP-47 language tag) of the localized listing to update
 * @param {string} imageType One of the following values: "featureGraphic", "icon", "promoGraphic", "tvBanner", "phoneScreenshots", "sevenInchScreenshots", "tenInchScreenshots", "tvScreenshots", "wearScreenshots"
 * @param {string} imagePath Path to image to attempt upload with
 * @returns {Promise} imageUploadPromise A promise that will return after the image upload has completed or failed. Upon success, returns an object
 *                                       { image: [ { id: string, url: string, sha1: string } ] }
 */
function uploadImage(edits: any, languageCode: string, imageType: string, imagePath: string) {
    tl.debug(`Uploading image of type ${imageType} from ${imagePath}`);
    let imageUploadRequest: PackageParams = {
        language: languageCode,
        imageType: imageType,
        uploadType: 'media',
        media: {
            body: fs.createReadStream(imagePath),
            mimeType: helperResolveImageMimeType(imagePath)
        }
    };

    tl.debug(`Making image upload request: ${JSON.stringify(imageUploadRequest)}`);
    edits.images.uploadAsync(imageUploadRequest)
    .catch((request, err) => {
        tl.debug(err);
        tl.debug(`Request detailes: ${JSON.stringify(request)}`);
        throw new Error(tl.loc('UploadImageFail'));
    });
}

/**
 * Attempts to resolve the image mime type of the given path.
 * Not compelete. DO NOT REUSE.
 * @param {string} imagePath Path to attempt to resolve image mime for.
 * @returns {string} mimeType Google Play accepted image mime type that imagePath most closely maps to.
 */
function helperResolveImageMimeType(imagePath: string): string {
    let extension: string = imagePath.split('.').pop();

    switch (extension) {
        case 'png':
            return 'image/png';
        case 'jpg':
        case 'jpeg':
            return 'image/jpeg';
        default:
            tl.debug(`Could not resolve image mime type for ${imagePath}. Defaulting to jpeg.`);
            return 'image/jpeg';
    }
}

/**
 * Update the universal parameters attached to every request
 * @param {string} paramName Name of parameter to add/update
 * @param {any} value value to assign to paramName. Any value is admissible.
 * @returns {void} void
 */
function updateGlobalParams(globalParams: GlobalParams, paramName: string, value: any): void {
    tl.debug('Updating Global Parameters');
    tl.debug('SETTING ' + paramName + ' TO ' + JSON.stringify(value));
    globalParams.params[paramName] = value;
    tl.debug('One line before end');
    google.options(globalParams);
    tl.debug('End Updating Global Parameters');
}

/**
 * Get the appropriate file from the provided pattern
 * @param {string} path The minimatch pattern of glob to be resolved to file path
 * @returns {string} path path of the file resolved by glob
 */
function resolveGlobPath(path: string): string {
    if (path) {
        // VSTS tries to be smart when passing in paths with spaces in them by quoting the whole path. Unfortunately, this actually breaks everything, so remove them here.
        path = path.replace(/\"/g, '');

        let filesList: string[] = glob.sync(path);
        if (filesList.length > 0) {
            path = filesList[0];
        }
    }

    return path;
}

// Future features:
// ----------------
// 1) Adding testers
// 2) Adding new images
// 3) Adding expansion files
// 4) Updating contact info

run();
