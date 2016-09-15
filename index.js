const fs = require('fs')
const path = require('path')
const got = require('got')
const fileSystem = require('original-fs');
const Zip = require('adm-zip');
const spawn = require('child_process').spawn;

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

const _getAsUriParameters = function (data) {
  return Object.keys(data).map(function (k) {
    if (Array.isArray(data[k])) {
      var keyE = encodeURIComponent(k + '[]');
      return data[k].map(function (subData) {
        return keyE + '=' + encodeURIComponent(subData);
      }).join('&');
    } else {
      return encodeURIComponent(k) + '=' + encodeURIComponent(data[k]);
    }
  }).join('&');
}


class Updater {

    constructor() {
        this.setup = {
            api: '',
            appPath: '',
            appPathFolder: '',
            requestOptions: {},
			//logFile: 'updater-log.txt',
			logFile: false,
            callback: false,
            update: {},
			totalUpdated: 0,
			myUpdates: {},
			myArchives: {}
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
				// If the "last" property is not defined
                if(!result.last){
                     throw false;
                }
						
				// Update available
				if(result.source){
					that.log('Update available: ' + result.last);
					// Store the response
					that.setup.update = result;
					// Ask user for confirmation
					that.end();
				} else {
					that.log('No updates available');
                    that.end(2);

                    return false;
				}
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
	
	/**
     * Detect modules
     * */
	modular_detect() { 
		let that = this;
		
		_walkSync(that.setup.appPathFolder, function(filePath, stat) {
			that.log(filePath);
			let fileName = _getFilename(filePath);			
			let extension = filePath.substring(filePath.lastIndexOf('.')+1);
			if (extension == 'asar' && fileName != 'electron.asar') {
				let archiveName = fileName.substring(0, fileName.lastIndexOf('.'));
				that.log(archiveName);
	
				// Get the current version
				/*
				let packageInfo = fs.readFileSync(that.setup.appPathFolder + fileName + '/package.json', "utf8");
				packageInfo = JSON.parse(packageInfo);				
				let archiveVersion = packageInfo.version;
				
				that.setup.myArchives[archiveName] = archiveVersion;
				*/
				
				// this causes asar file lock
				let packageInfo = require(that.setup.appPathFolder + fileName + '/package.json');
				let archiveVersion = packageInfo.version;
			
				that.setup.myArchives[archiveName] = archiveVersion;
				
			}
		});
		
		
		//that.setup.myArchives["app-pda"] = "1.0.1";
		//that.setup.myArchives["app"] = "1.0.0";

		that.log(that.setup.myArchives);
	}
	
	/**
     * Make the check for the update
     * */
    modular_check(callback) {
        if (callback) {
            this.setup.callback = callback;
        }

        let that = this;
		
		that.modular_detect();
		
		// If the version property not specified
        if (!that.setup.myArchives) {
            that.log('The "version" property not specified inside the application package.json');
            that.end(0);
            return false;
        }

		let params = _getAsUriParameters(that.setup.myArchives);
		that.log(params);

        return _fetchJson(this.setup.api + '?' + params + '&v=' + Date.now())
            .then(result => {
				// If the "last" property is not defined
				/*
                if(!result.last){
                     throw false;
                }
				*/
				let hasUpdate = false;
						
				Object.keys(result).forEach(function(key) {
					//console.log(key, result[key]);
					
					// Update available
					if (result[key].source) {
						that.log(key+' - Update available : ' + result[key].last);
						// Store the response
						that.setup.myUpdates[key] = result[key];
				
						hasUpdate = true;		
					}
					
				});

				if (hasUpdate) {
					// Ask user for confirmation
					console.log(that.setup.myUpdates);
					that.end();
				} else {
					that.log('No updates available');
                    that.end(2);

                    return false;
				}						
				
            })
    }
		
	/**
     * Download the update files
     * */
    modular_download(callback) {
        if (callback) {
            this.setup.callback = callback;
        }

        let that = this;
		let code = 0;
		
		if (that.setup.myUpdates) {
			that.setup.totalUpdated = Object.keys(that.setup.myUpdates).length;
			that.log('Total Updates:' + that.setup.totalUpdated);
			
			Object.keys(that.setup.myUpdates).forEach(function(key) {				
				let currentUpdate = that.setup.myUpdates[key];
				//console.log(key, currentUpdate);
								
				let url = currentUpdate.source, fileName = 'update-'+key+'.maj';
				if (currentUpdate.source_zip) {
					url = currentUpdate.source_zip;
					fileName = 'update-'+key+'.zip';
				}
				
				let dist = path.join(that.setup.appPathFolder, fileName);
				
				that.log(key+' - Downloading:' + url);

				_fetchFile(url + '?v=' + Date.now(), dist)
					//.progress(p => this.emit('progress', task, p))
					.then(filename => {
						that.setup.myUpdates[key].file = dist;
						that.log(key+' - Update downloaded: ' + dist);						
						code = that.modular_apply(key);
						that.setup.totalUpdated--;
						if (that.setup.totalUpdated < 1) {
							// Success
							that.log('End of all updates:' + that.setup.totalUpdated);		
							that.end();
						}
				});
			
			});
			
			/*
			if (code > 0) {
				// Failure
				that.end(code);
			} else {
				// Success
				that.end();
			}
			*/
		}		
    }
	
	/**
     * Apply the update, it simply overwrites the current files!
     * */
    modular_apply(key) {
        let that = this;
	
        try {
			var extension = that.setup.myUpdates[key].file.substring(that.setup.myUpdates[key].file.lastIndexOf('.')+1);
			if (extension && extension == 'zip') {
				that.log(key+' - Extracting the new update files.');

                var zip = new Zip(that.setup.myUpdates[key].file);
                zip.extractAllTo(that.setup.appPathFolder, true);
				
				that.log(key+' - New update files were extracted.');
				
				let urlToDelete = that.setup.appPathFolder + 'update-'+key+'.zip';
				fileSystem.unlinkSync(urlToDelete);
				that.log(key+" - Zip deleted successfully.");
			} 
		} catch (error) {
            that.log(key+' - Extraction error: ' + error);

            // Failure
            return 6;
        }				
			
		try {
			let urlToDelete = that.setup.appPathFolder + key + '.asar'; 
			console.log('urlToDelete '+urlToDelete);
			//this.setup.appPath.slice(0, -1)
			fileSystem.unlinkSync(urlToDelete);
			that.log(key+" - Asar deleted successfully.");
					 /*
					fileSystem.unlink(urlToDelete, function (err) {
						if (err) {
							return console.error(err);
						}
						that.log(key+" - Asar deleted successfully.");
					})
					*/
			that.log(key+' - Renaming the new update files.');
				
			fileSystem.renameSync(that.setup.myUpdates[key].file, that.setup.appPathFolder + key + '.asar');
				
			that.log(key+" - Update applied.");
					/*
					fileSystem.rename(that.setup.myUpdates[key].file, that.setup.appPathFolder + key + '.asar', function (err) {
						if (err) {
							that.force_copy(key);
							//return console.error(err);
						}
						that.log(key+" - Update applied.");
					})
					*/					
			
		} catch (error) {
			that.log(key+' - Delete/Rename error: ' + error);
			
			that.force_copy(key);
			// Failure
			//return 6;
		}
				
			
		that.log(key+' - End of update.');
			
        // Success
		return 0;
			     
    }
	
	// app.asar is always EBUSY on Windows or some other modules are locked with modular_detect checking package version, 
	// so we need to try another way of replacing it. With xcopy, we dont need to call it after the main Electron
    // process has quit. 
    force_copy(key) {
		let that = this;
		
		key = key || 'app';
		that.log('force_copy key='+key);
		 
        let updateAsar = this.setup.appPathFolder + 'update-' + key + '.maj';
        let appAsar = this.setup.appPathFolder + key + '.asar';
        let winArgs = "";
          
        that.log("Checking for " + updateAsar);
        try {
            that.log("Going to shell out to move: " + updateAsar + " to: " + appAsar);

            if (process.platform === 'win32') {
              // so ugly - this opens a dos window, which waits for 5 seconds (by which time the app.asar is not EBUSY)
              // and then does the move - really needs to be invisible, but will do ATM
			  
              //winArgs = 'xcopy /V /Y "'+updateAsar+'" "'+appAsar+'"';
			  //winArgs = 'xcopy /V /Y "'+updateAsar+'" "'+appAsar+'" && del /Q "'+updateAsar+'"';
			  winArgs = 'xcopy /V /Y "'+updateAsar+'" "'+appAsar+'" && if errorlevel 0 (del /Q "'+updateAsar+'")';
			  //winArgs = this.setup.appPathFolder+'update.bat "'+updateAsar+'" "'+appAsar+'"';
			  
			  //winArgs = 'move /y "'+updateAsar+'" "'+appAsar+'"';
			  //winArgs = `timeout /t 5 > nul && move /y ${JSON.stringify(updateAsar)} ${JSON.stringify(appAsar)}`
              that.log(winArgs);
              const childpid = spawn('cmd', ['/s', '/c', '"'+winArgs+'"'], {detached: true, windowsVerbatimArguments: true, stdio: 'ignore'});
			  //child.spawn('cmd', ['/s', '/c', '"' + winArgs + '"'], {detached: true, windowsVerbatimArguments: true, stdio: 'ignore'});
			  childpid.unref; // let the child live on
            
            } else {
              //child.spawn('bash', ['-c', ['cd ' + JSON.stringify(this.setup.appPathFolder), 'mv -f update.asar app.asar'].join(' && ')], {detached: true});
            }
            //child.unref; // let the child live on
            
            // child.exec(`${process.platform==='win32'?'move /y':'mv'} "${updateAsar}" "${appAsar}"`)
        } catch(error) {
            that.log("Shelling out to move failed: " + error);
        }

    }
}

module.exports = new Updater()