const puppeteer = require('puppeteer');
const Spectre = require('./spectre');
const Result = require('./result');
const util = require('util');
const execFile = util.promisify(require('child_process').execFile);
const del = require('del')
const colors = require('colors');
const mkdirp = require('mkdirp');
const crypto = require('crypto');
const pngquant = require('pngquant-bin');
const path = require('path');
const fs = require('fs');


//setup must be available in base folder
var setup = require(path.resolve('./','setup.json'));

var argv = require('minimist')(process.argv.slice(2));

let test = setup.defaults.test;
if (argv._.length === 1) {
    test = argv._[0];
}
if (argv.test) {
    test = argv.test;
}

//test config must be available in base or visual-tests folder
let config;
if (fs.existsSync(path.resolve('./',`${test}.json`))) {
    config = require(path.resolve('./',`${test}.json`));
}

if (fs.existsSync(path.resolve('./','visual-tests',`${test}.json`))) {
    config = require(path.resolve('./','visual-tests',`${test}.json`));
}

if (typeof config === 'undefined'){
    console.log('Error: Config json file not found in base or "visual-tests" folder'.red);
    process.exit(2);

}

let environment = setup.defaults.environment;
if (argv.env) {
    environment = argv.env;
}

let isHeadless = true;
if (argv.debug) {
    isHeadless = false;
    console.log('DEBUG: Headless mode deactivated'.green);
}


/**
 * Configuration
 */

const baseURL = eval('`' + config.baseURL + '`');
const loginURL = config.loginURL ? eval('`' + config.loginURL + '`') : 

console.log(`Config: ${test} - Target: ${maskPW(baseURL)}`.yellow);

let run_id, spectre, screenshot_name;

spectre = new Spectre(setup.spectreServer);
const CM_USER = setup.cmUser;
const CM_BASICAUTH = setup.basicAuth || '';
const PAGE_LOAD_WAIT = 1000;
const IDLE_TIMEOUT = 1000;

//iq param must be in last place
const suffixURL = 'test=automation&cachebuster=' + new Date().getTime() + '&_?iqadtest=iqviewadplace';


let setups = [];
config.setups.forEach(function (setupKey) {
    if (setup.defaults.setups[setupKey]) {
        setups.push(setup.defaults.setups[setupKey]);
    }
});

//pixel after screenshots being split
const splitSize = setup.splitSize;
//result processing
let returnCode = 0;
let result = new Result(config, setup);

const auth = new Buffer(`${CM_BASICAUTH}`).toString('base64');


function testResult(res) {
    let json = res.body;
    console.log('Result: ' + (json.pass ? "PASSED".green : "FAILED".red));
    if (!json.pass) {
        returnCode = 1;
    }
    result.addTestResult(json);
}

function maskPW(s) {
    return s.replace(/\/\/.*:.*@/, '//user:pass@');
}



mkdirp.sync('temp');
del.sync(['temp/*.png']);

/**
 * Start Sync Automation
 */
(async () => {
    let setup, hasError, testURL, pageHeight, screenshotParts, uploadResponse, page, noFullPage;
    try {
        let spectreObj = await spectre.startRun(config.project, config.suite);
        run_id = spectreObj.id;
        console.log(('TestID: ' + run_id).gray);
        result.setSpectre(spectreObj);
        const browser = await puppeteer.launch({
            //ignoreHTTPSErrors: true, //causes interception errors
            dumpio: false,
            headless: isHeadless,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });


        
        for (var j = 0; j < setups.length; j += 1) {
            hasError = false;
            setup = setups[j];
            result.addRun(setup.name);
            console.log(('Setup: ' + setup.name).gray);

            page = await browser.newPage();

            if (setup.viewport) {
                await page.setViewport(setup.viewport);
            }

            if (setup.userAgent) {
                await page.setUserAgent(setup.userAgent);
            }

            await page.waitFor(PAGE_LOAD_WAIT);

            //if (CM_BASICAUTH){
            //    await page.setExtraHTTPHeaders({
            //        'Authorization': `Basic ${auth}`,
            //        'X-Test': 'Automation'                  
            //    });
            //} else {
                //Hint Target about Auto Test
                await page.setExtraHTTPHeaders({
                    'X-Test': 'Automation'                    
                });
            //}

            await page.setRequestInterception(true);
            page.on('request', request => {
              if (CM_BASICAUTH && request.url().indexOf(baseURL) > -1){
                const headers = request.headers();
                headers['Authorization'] = `Basic ${auth}`;
                request.continue({ headers });
              } else {
                request.continue();
              }
            });


            //Catch CM login page
            var loginPage = {
                name: '[name=username]',
                pass: '[name=password]',
                commit: '[name=commit]'
            };

            console.log(('URL: ' + maskPW(loginURL || baseURL)).gray);
            await page.goto(loginURL || baseURL, {
                waitUntil: 'networkidle2',
                timeout: 60000
            });
            
            await page.waitFor(500);
        
            if (await page.$(loginPage.name) !== null) {
                console.log('Found Login Page...');
                await page.type(loginPage.name, CM_USER);
                console.log('User entered...');
                await page.type(loginPage.pass, crypto.createHash('md5').update(CM_USER).digest('hex'));
                console.log('Pass entered...');
                await page.waitFor(500);
                await Promise.race([
                    page.click(loginPage.commit),
                    new Promise(function(resolve, reject) {
                        function timeout(){
                            console.log(('Timeout... trying to continue').red);
                            resolve();
                        }
                        setTimeout(timeout, 5000);
                    })
                ]);
                
                console.log('Login button hit...');
                //navigation after login is non deterministic, thatfor just wait 5 seconds and hope everything is ok :)                
                await page.waitFor(5000);
                console.log('Login done!');
            } else {
                console.log('No Login page.');
            }


            for (var i = 0; i < config.tests.length; i += 1) {

                console.log(('Test: ' + config.tests[i].name).yellow);

                testURL = baseURL + config.tests[i].url + ((config.tests[i].url.indexOf('?') > -1) ? '&' : '?') + suffixURL;


                noFullPage = (config.tests[i].fullpage === false);

                result.addTest(config.tests[i].name, testURL);

                if (config.tests[i].url.substr(0, 4) === "http") {
                    testURL = config.tests[i].url;
                }
                await page.goto('about:blank');
                console.log(('URL: ' + maskPW(testURL)).gray);

                await page.goto(testURL, {
                    waitUntil: 'networkidle2'
                });

                //time for js to finish
                await page.waitFor((config.tests[i].wait || 1) * 1000);

                //check height
                const pageHeight = await page.evaluate(() => {
                    return document.body.scrollHeight;
                });
                console.log(('Page height:' + pageHeight + ' - Max: ' + splitSize).gray);

                if (config.tests[i].hover){
                    console.log(('Hover over "'  + config.tests[i].hover + '". Fullscreen screenshot disabled.').gray);
                    noFullPage = true;
                    await page.hover(config.tests[i].hover);
                }

                if (!hasError) {
                    if (!noFullPage && pageHeight > (splitSize * 1.3)) {
                        screenshotParts = Math.ceil(pageHeight / splitSize);
                        console.log(('Splitting in ' + screenshotParts + ' parts.').gray);
                        for (let part = 0; part < screenshotParts; part += 1) {
                            screenshot_name = 'temp/s' + j + 's' + i + '.' + part + '.png';
                            console.log(('Creating Screenshot: ' + screenshot_name).gray);
                            await page.screenshot({
                                path: screenshot_name,
                                clip: {
                                    x: 0,
                                    y: splitSize * part,
                                    width: page.viewport().width,
                                    height: ((part + 1) === screenshotParts) ? (pageHeight - (splitSize * part)) : splitSize
                                }
                            });
                            await execFile(pngquant, [screenshot_name]);
                            try {
                                if (!hasError) {
                                    console.log(('Sending Screenshot #' + i + '.' + part + " to server.").gray);
                                    uploadResponse = await spectre.uploadScreenshot(run_id, config.tests[i].name + '.' + part, 'headlessChromium', setup.name, screenshot_name.replace('.png', '-fs8.png'));
                                }
                            } catch (ex) {
                                console.log(('Error sending Screenshot #' + i + '.' + part + ": ").red, ex);
                            }
                            console.log(('Screenshot #' + i + '.' + part + ' done').gray);
                            testResult(uploadResponse);
                        }
                    } else {
                        screenshotParts = 1;
                        screenshot_name = 'temp/s' + j + 's' + i + '.png';
                        await page.screenshot({
                            path: screenshot_name,
                            fullPage: noFullPage ? false : true
                        });
                        await execFile(pngquant, [screenshot_name]);
                        try {
                            if (!hasError) {
                                console.log(('Sending Screenshot #' + i + " to server.").gray);
                                uploadResponse = await spectre.uploadScreenshot(run_id, config.tests[i].name, 'headlessChromium', setup.name, screenshot_name.replace('.png', '-fs8.png'));
                            }
                        } catch (ex) {
                            console.log(('Error sending Screenshot #' + i + ": ").red, ex);
                        }
                        console.log(('Screenshot #' + i + ' done').grey);
                        testResult(uploadResponse);
                    }
                }
            }

            await page.close();

        }

        await browser.close();
        console.log('Done'.yellow);
        result.finish();

    } catch (error) {
        if (page){
            console.log('Current Page URL: ' + page.url());
        }
        console.log('ERROR'.red, error);
        returnCode = 1;
        result.error(error);

    }
    console.log('Exit ' + returnCode);
    process.exit(returnCode);

})();