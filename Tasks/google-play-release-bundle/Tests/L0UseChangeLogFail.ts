import * as ma from 'azure-pipelines-task-lib/mock-answer';
import * as tmrm from 'azure-pipelines-task-lib/mock-run';
import * as sinon from 'sinon';

import path = require('path');

const taskPath = path.join(__dirname, '..', 'GooglePlay.js');
const tr: tmrm.TaskMockRunner = new tmrm.TaskMockRunner(taskPath);

process.env['ENDPOINT_AUTH_myServiceEndpoint'] = '{ "parameters": {"username": "myUser", "password": "myPass"}, "scheme": "UsernamePassword"}';

tr.setInput('authType', 'ServiceEndpoint');
tr.setInput('serviceEndpoint', 'myServiceEndpoint');
tr.setInput('applicationId', 'myPackage');
tr.setInput('bundleFile', '/path/to/bundle');
tr.setInput('track', 'Production');
tr.setInput('shouldAttachMetadata', 'false');
tr.setInput('changelogFile', '/path/to/changelog');
tr.setInput('languageCode', 'lang-Code');

// provide answers for task mock
const a: ma.TaskLibAnswers = <ma.TaskLibAnswers>{
    'checkPath': {
        '/path/to/bundle': true,
        '/path/to/changelog': true
    },
    'stats': {
        '/path/to/changelog': {
            isFile: () => true,
            isDirectory: () => false
        }
    }
};
tr.setAnswers(a);

tr.registerMock('./googleutil', {
    publisher: {
        edits: {
            commit: sinon.stub()
        }
    },
    getJWT: () => {
        return {
            authorize: sinon.stub()
        };
    },
    getNewEdit: () => Promise.resolve({}),
    getTrack: () => Promise.resolve({}),
    updateTrack: () => Promise.resolve({}),
    updateGlobalParams: () => Promise.resolve({}),
    addBundle: () => Promise.resolve({ versionCode: 1 })
});

tr.registerMock('glob', {
    sync: (path) => [path]
});

tr.run();
