const fs = require('fs')
//const _ = require('lodash')
const path = require('path')
const got = require('got')
const fileSystem = require('original-fs');
const Zip = require('adm-zip');
//const os = require('os')

const errors = [
    'version_not_specified',
    'cannot_connect_to_api',
    'no_update_available',
    'api_response_not_valid',
    'update_file_not_found',
    'failed_to_download_update',
    'failed_to_apply_update'
]

const _fetchJson = function (url) {
    return got(url, {encoding: 'utf8', timeout: 1500, retries: 1, json: true, headers: this.headers})
        .then(response => Promise.resolve(response.body))
}

const _fetchFile = function (url, dist) {
    let onProgress = p => console.log(p)
    let total = 0
    let current = 0
    let timer = null
    console.log(dist)
    const promise = new Promise((resolve, reject) => {
        got.stream(url, {encoding: 'utf8', timeout: 1500, retries: 1, headers: this.headers})
            .on('request', request => {
                timer = setTimeout(() => request && request.abort(), 2 * 60 * 1000)
            })
            .on('response', response => response.headers['content-length'] ? (total = parseInt(response.headers['content-length'], 10)) : onProgress(-1))
            .on('data', chunk => total ? onProgress((current += chunk.length) / total) : onProgress(-1))
            .on('end', chunk => clearTimeout(timer))
            .on('error', (error, body, response) => reject(error))
            //.pipe(zlib.Gunzip())
            .pipe(fs.createWriteStream(dist))
            // .pipe(unzip.Extract({ path: this.folder }))
            .on('error', (error) => reject(error))
            .on('close', () => resolve(dist))
    })
    promise.progress = callback => {
        onProgress = callback
        return promise
    }
    return promise
}

// sync version
const _walkSync = function(currentDirPath, callback) {
    var fileSystem = require('original-fs'),
        path = require('path');
    fileSystem.readdirSync(currentDirPath).forEach(function (name) {
        var filePath = path.join(currentDirPath, name);
        var stat = fileSystem.statSync(filePath);
        if (stat.isFile()) {
            callback(filePath, stat);
        } else if (stat.isDirectory()) {
            //_walkSync(filePath, callback);
        }
    });
}

const _getFilename = function (str) {
    return str.split('\\').pop().split('/').pop();
}


class Updater {

    constructor() {
        this.setup = {
            api: '',
            appPath: '',
            appPathFolder: '',
            requestOptions: {},
			logFile: 'updater-log.txt',
            callback: false,
            update: {}			
        }
		/*
		update': {
				'last': null,
				'source': null,
				'file': null
			},
		*/
    }

	/**
     * Logging
     * */
    log(line) {
		// Log it
		console.log('Updater: ', line);
		
		// Put it into a file
        if(this.setup.logFile){
			fileSystem.appendFileSync(this.setup.appPathFolder + this.setup.logFile, line + "\n");
        }
    }

	/**
     * Init the module
     * */
    init(setup) {
		this.setup = Object.assign(this.setup, setup);
        //this.setup.appPath = this.setup.appPath + '/';
		if (this.setup.appPath.indexOf("app.asar") != -1) {
            this.setup.appPathFolder = this.setup.appPath.slice(0, this.setup.appPath.indexOf("app.asar"));
		} else {		
			this.setup.appPathFolder = this.setup.appPath.slice(0, this.setup.appPath.indexOf("app"));	
		}
        this.log(this.setup);
    }

	/**
     * Triggers the callback you set to receive the result of the update
     * */
    end(error) {
        if (typeof this.setup.callback != 'function') return false
        this.setup.callback.call(this,
            ( error != 'undefined' ? errors[error] : false ),
            this.setup.update.last)
    }

	/**
     * Detect modules
     * */
	detect() { 
		let that = this;
		_walkSync(this.setup.appPathFolder, function(filePath, stat) {
			that.log(filePath);
			var fileName = _getFilename(filePath);
			that.log(fileName);
			that.log(fileName.substring(0, fileName.lastIndexOf('.')));
			var extension = filePath.substring(filePath.lastIndexOf('.')+1);
			if (extension == 'asar') {
				// @todo push into a collection
				
				//require(filePath);
			}
		});
	}
	
	/**
     * Make the check for the update
     * */
    check(callback) {
        if (callback) {
            this.setup.callback = callback;
        }

		// Get the current version
        let packageInfo = require(this.setup.appPath + 'package.json');
        let currentVersion = packageInfo.version;
		
		// If the version property not specified
        if (!currentVersion) {
            this.log('The "version" property not specified inside the application package.json');
            this.end(0);
            return false;
        }

        let that = this;

        return _fetchJson(this.setup.api + '?version=' + currentVersion + '&v=' + Date.now())
            .then(result => {
                that.log('Update available: ' + result.version)
                that.setup.update = result
                // Ask user for confirmation
                that.end()
            })
    }

	/**
     * Download the update file
     * */
    download(callback) {
        if (callback) {
            this.setup.callback = callback;
        }

        let that = this;
        let url = this.setup.update.url, fileName = 'update';
        let dist = path.join(this.setup.appPathFolder, fileName);

        this.log('Downloading:' + url);

        _fetchFile(url + '?v=' + Date.now(), dist)
        //.progress(p => this.emit('progress', task, p))
            .then(filename => {
                that.setup.update.file = dist
                that.log('Update downloaded: ' + dist)
                that.apply()
            })
    }

	/**
     * Apply the update, it simply overwrites the current files!
     * */
    apply() {
        let that = this;
        try {
            fileSystem.unlink(this.setup.appPath.slice(0, -1), function (err) {
                if (err) {
                    return console.error(err);
                }
                that.log("Asar deleted successfully.");
            })
        } catch (error) {
            that.log('Delete error: ' + error);

            // Failure
            that.end(6);
        }

        try {
			var extension = this.setup.update.file.substring(this.setup.update.file.lastIndexOf('.')+1);
			if (extension == 'zip') {
				this.log('Extracting the new update files.');

                var zip = new Zip(this.setup.update.file);
                zip.extractAllTo(this.setup.appPathFolder, true);
				
				this.log('New update files were extracted.');
			} else {
				this.log('Renaming the new update files.');
				
				fileSystem.rename(this.setup.update.file, this.setup.appPath.slice(0, -1), function (err) {
					if (err) {
						return console.error(err);
					}
					that.log("Update applied.");
				})
			}
			
			that.log('End of update.');
			
            // Success
            that.end();

        } catch (error) {
            that.log('Extraction/Rename error: ' + error);

            // Failure
            that.end(6);
        }
    }
}

module.exports = new Updater()