const STATE = {
    PASSED: 'PASSED',
    FAILED: 'FAILED',
    ERROR: 'ERROR'
};


class Result {

    constructor(config, setup) {
      this.result = STATE.PASSED;
      this.spectrReport = setup.spectreServer;
      this.failedTest = {};
      this.config = config;
      this.runs = {};
    }

    setSpectre(spectre){
        this.spectre = spectre;
        this.spectrReport += spectre.url;
    }

    addRun(runName){
        var currentRun = [];
        this._currentRun = currentRun;
        this.runs[runName] = currentRun;
    }

    addTest(name, url){
        var currentTest = {
            name: name,
            url: url,
            passed: true
        };
        this._currentTest = currentTest;
        this._currentRun.push(currentTest);
    }

    addTestResult(result){
        if (!result.pass){
            this.result = STATE.FAILED;
            this._currentTest.passed = false;
            this.failedTest = this._currentTest;
        }
    }

    error(err){
        this.error = err;
        this.result = STATE.ERROR;
    }

    finish(){
        //After test finished without techinical errors
    }

    get(){  
        var json = {...this}
        delete json._currentRun;
        delete json._currentTest;
        if (json.result === STATE.PASSED){
            delete json.failedTest;
        }
        return json;
    }

}

module.exports = Result;