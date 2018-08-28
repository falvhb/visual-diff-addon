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

//test config must be available in base folder
const config = require(path.resolve('./',`${test}.json`));

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

console.log(`Config: ${test} - Target: ${maskPW(baseURL)}`.yellow);

let run_id, spectre, screenshot_name;

spectre = new Spectre(setup.spectreServer);
const CM_USER = setup.cmUser;
const CM_BASICAUTH = setup.basicAuth;
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
    try {
        let spectreObj = await spectre.startRun(config.project, config.suite);
        run_id = spectreObj.id;
        console.log(('TestID: ' + run_id).gray);
        result.setSpectre(spectreObj);
        const browser = await puppeteer.launch({
            ignoreHTTPSErrors: true,
            headless: isHeadless
        });


        let setup, hasError, testURL, pageHeight, screenshotParts, uploadResponse, page;
        for (var j = 0; j < setups.length; j += 1) {
            hasError = false;
            setup = setups[j];
            result.addRun(setup.name);
            console.log(('Setup: ' + setup.name).gray);

            page = await browser.newPage();

            if (setup.viewport) {
                await page.setViewport(setup.viewport);
            }
            if (setup.device) {
                await page.emulate(setup.device);
            }
            await page.waitFor(PAGE_LOAD_WAIT);

            if (CM_BASICAUTH){
                const auth = new Buffer(`${CM_BASICAUTH}`).toString('base64');
                await page.setExtraHTTPHeaders({
                    'Authorization': `Basic ${auth}`,
                    'X-Test': 'Automation'                  
                });
            } else {
                //Hint Target about Auto Test
                await page.setExtraHTTPHeaders({
                    'X-Test': 'Automation'                    
                });
            }

            //Catch CM login page
            var loginPage = {
                name: '[name=username]',
                pass: '[name=password]',
                commit: '[name=commit]'
            };

            await page.goto(baseURL);
            if (await page.$(loginPage.name) !== null) {
                console.log('Found Login Page')
                await page.type(loginPage.name, CM_USER);
                await page.type(loginPage.pass, crypto.createHash('md5').update(CM_USER).digest('hex'));
                await page.click(loginPage.commit);
                await page.waitForNavigation();
            }


            for (var i = 0; i < config.tests.length; i += 1) {

                console.log(('Test: ' + config.tests[i].name).yellow);

                testURL = baseURL + config.tests[i].url + ((config.tests[i].url.indexOf('?') > -1) ? '&' : '?') + suffixURL;

                result.addTest(config.tests[i].name, testURL);

                if (config.tests[i].url.substr(0, 4) === "http") {
                    testURL = config.tests[i].url;
                }
                await page.goto('about:blank');
                console.log(('URL: ' + maskPW(testURL)).gray);

                try {
                    await page.goto(testURL, {
                        waitUntil: 'networkidle2',
                        timeout: 60000
                    });
                } catch (ex) {
                    hasError = true;
                    console.log('Error navigating in Browser: '.red, ex);
                }
                //time for js to finish
                await page.waitFor((config.tests[i].wait || 1) * 1000);

                if (!hasError) {
                    const pageHeight = await page.evaluate(() => {
                        return document.body.scrollHeight;
                    });
                    console.log(('Page height:' + pageHeight + ' - Max: ' + splitSize).gray);
                    if (pageHeight > (splitSize * 1.3)) {
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
                            fullPage: true
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
        console.log('ERROR'.red, error);
        returnCode = 1;
        result.error(error);

    }
    console.log('Exit ' + returnCode);
    process.exit(returnCode);

})();