/*
 * App Script by Ben Morss, @morss, 2017.  You can share this!
 * Reuses bits of Andy Davies' excellent script:
 * Copyright (c) 2013-2014 Andy Davies, @andydavies, http://andydavies.me
 *
 * This script retrieves a list of URLs from a sheet.
 * It sends off a request to the Webpagetest API to test the speed of each page.
 * Using a time-based trigger, it repeatedly queries the API to see if each test is complete.
 * When a test finishes, it writes the results to the sheet.
 * And if the results exceed user-defined limits, it generates and sends a warning email.
 * C'est tout!
 *
 * v1.1, 8/4/17: support for multiple URLs, each in their own tab
 * v1.2, 1/3/19: minor fixes, including better handling of blank email addresses
 * v1.3, 1/23/19: added link to full results in WPT
 */

/******************************
 * CONSTANTS AND GLOBALS      *
 ******************************/
 
// Strings
var ALERT_EMAIL_SUBJECT = 'An alert about your mobile site speed';
var ALERT_EMAIL_NO_HTML = "Sorry, your email client doesn't support HTML.";
var ALERT_EMAIL_BCC = '';
 
// Constants
var MAX_URLS = 10;                   // the most URLs this spreadsheet will support, limited to save API quota

// Named ranges from spreadsheet
var API_KEY = "APIKey";
var API_MESSAGE = "APIMessage";
var WPT_PENDING_TESTS = "PendingTests";
var ALERT_THRESHOLDS = "AlertThresholds";
var ALERT_EMAILS = "AlertEMails";

// Cells where we expect to find stuff
var URL_CELL = 'B1';

// Spreadsheet objects
var ss = SpreadsheetApp.getActive();
var configSheet = ss.getSheetByName('Config');
var alertingSheet = ss.getSheetByName('Alerting');
var scratchSheet = ss.getSheetByName('Scratch');

// Webpagetest API
var WPT_API_URL = 'http://webpagetest.org/runtest.php';

var WPT_PARAMS = {
  'k': getAPIKey(),
  'f': 'json',
  'video': 1,                       // need to capture video to calculate SpeedIndex
  'location': 'Dulles:Chrome.3G',
  'mobile': 1,
  'fvonly': 1                       // we only need the first view
};

// Map for metrics from Webpagetest.  Each object contains:
// {wptName: [the name used by Webpagetest API], prettyName: [human-readable vname], units: [units]}
var DATA_POINTS = [
  {wptName: 'requestsFull', prettyName: 'number of requests', units: ''},
  {wptName: 'bytesIn', prettyName: 'bytes loaded', units: 'bytes'},
  {wptName: 'SpeedIndex', prettyName: 'Webpagetest Speed Index', units: 'milliseconds'},
  {wptName: 'firstPaint', prettyName: 'time to first paint', units: 'milliseconds'},
  {wptName: 'visualComplete', prettyName: 'time to visual completeness', units: 'milliseconds'},
  {wptName: 'fullyLoaded', prettyName: 'time to full page load', units: 'milliseconds'},
  {wptName: 'image_total', prettyName: 'image bytes', units: 'bytes'},
  {wptName: 'image_savings', prettyName: 'bytes that could be saved through image compression', units: 'bytes'},
  {wptName: 'gzip_savings', prettyName: 'bytes that could be saved through gzip', units: 'bytes'}
];



/******************************
 * MAIN FUNCTIONS             *
 ******************************/

/**
 * Get a list of URLs to test from the trix.
 * For each URL, build a Webpagetest API request and fire it off.
 * These take a little while to return, so for each request,
 * remember to keep polling the API to see if it's complete. 
 */

function main() {
  var wptTests = [];
 
  var tests = getThingsToTest();
  Logger.log("Preparing to test these URLs and sheets: "); Logger.log(tests);
 
  for (var i = 0; i < tests.length; i++) {
    var url = tests[i].url.trim();
    if (isValidURL(url)) {

      // For each URL, grab the standard params, append the URL, and make a query string.
      var params = copyObject(WPT_PARAMS);
      params.url = url;
      var querystring = buildQueryString(params);
            
      // Append the query string to Webpagetest's URL API and submit test.
      var response = UrlFetchApp.fetch(WPT_API_URL + '?' + querystring);
      Logger.log('Submitted request to ' + WPT_API_URL + '?' + querystring);

      var result = JSON.parse(response.getContentText());
      Logger.log('Request result is '); Logger.log(result);

      // WPT kindly gives us a new URL to poll to see when test is complete.
      if(result.statusCode == 200)
        wptTests.push({
          sheetName: tests[i].sheetName,
          url: result.data.jsonUrl
        });
      else
        ss.getRange(API_MESSAGE).setValue(['Sorry, Webpagetest failed with code ' + result.statusCode]);
    } else {
    
      ss.toast('As far as we know, "' + url + ' is not a valid URL. Skipping.', 'Just so you know');
    }
  }  
  
  // If any tests were submitted above, write those new WPT URLs to the scratch area of the sheet,
  // and start trigger to poll for results.

  if (wptTests.length) {
    Logger.log('We submitted these tests:'); Logger.log(wptTests);
    saveTests(wptTests);
    startTrigger();
  }
}


/**
 * Checks the status of any incomplete tests.
 * If a test is complete, parse the results and put into sheet.
 */
function pollForResults() {
  var resultsStillPending = false;                      // are WPT results still pending?
  var wptResults;
  var numberOfValuesToWrite = DATA_POINTS.length + 2;   // we're going to write the date and WPT URL too
  var thresholds = getAlertThresholds();

// Get all the URLs the Webpagetest API has given us to check the status of each test.
// Try each out and see how the test is progressing.
  Logger.log('pollForResults() triggered');
  
  try {
    var wptTests = getTests();
    
    for (var i = 0; i < wptTests.length; i++) {
      var testURL = wptTests[i].url;
      if (testURL) {
        var response = UrlFetchApp.fetch(testURL);
        var json = JSON.parse(response.getContentText());
        
        // Status code 200 means the test is complete.
        // In that case, grab the results and pull out the data points we want.
        // Put that data into the sheet.
        if (json.statusCode == 200) {
          var jsonResults = json.data.median.firstView;
          var wptResultsURL = json.data.summary;
          Logger.log('test for ' + jsonResults.URL + ' is complete');
          removeTestFromPendingList(wptTests[i]);
          
          wptResults = [];
          for (var d = 0; d < DATA_POINTS.length; d++)
            wptResults.push(Math.round(jsonResults[DATA_POINTS[d].wptName]));
          
          // Include the date and a link to the Webpagetest results page
          var wptLink = '=HYPERLINK("' + wptResultsURL + '", "Full results")';
          var trixResults = [[new Date()].concat(wptResults).concat(wptLink)];
          
          var sheet = ss.getSheetByName(wptTests[i].sheetName);
          var range = sheet.getRange(sheet.getLastRow() + 1, 1, 1, numberOfValuesToWrite);
          range.setValues(trixResults);
          
          emailIfPastThresholds(jsonResults.URL, wptResultsURL, wptResults);
          
        } else {
          Logger.log('test for ' + json.data.testInfo.url + ' is still pending');
          resultsStillPending = true;
        }
      }
      
// If we hit an error, cancel the trigger. Log error message and mention it in the sheet.
// No doubt it would be better if this were more user-friendly!
      
    }
  } catch (err) {
      Logger.log('Error encountered: "' + err.message + '". Canceling trigger and aborting.');
      var sheet = ss.getSheets()[0];
      var range = sheet.getRange(sheet.getLastRow() + 1, 1, 1, 2);
    var trixStuff = [[new Date(), 'Error encountered: ' + err.message + '. Sorry!']];
      range.setValues(trixStuff);
  }

  // If all tests have completed, cancel the trigger
  if (!resultsStillPending)
    cancelTrigger();
}



/**
 * Check whether WPT results should trigger an email alert.
 * Simply check the results against the thresholds set by the user.
 */
function emailIfPastThresholds(url, wptResultsURL, wptData) { 
  var options = {
    'name': 'Speed Demon (mobile site speed alert-bot)',
    'body': ALERT_EMAIL_NO_HTML 
  };

  if (ALERT_EMAIL_BCC)
    options.bcc = ALERT_EMAIL_BCC;
  
  var thresholds = getAlertThresholds();

  var offenders = pastThresholds(wptData, thresholds);
  
  if (offenders.length) {
    var recipients = getEmailRecipients();

    var body = generateEmailBody(url, wptResultsURL, offenders);
    Logger.log('email body is '); Logger.log(body);
    options.htmlBody = body;
    MailApp.sendEmail(recipients, ALERT_EMAIL_SUBJECT, "Sorry, your email client doesn't support HTML.", options);
  }
}


/**
 * Compare thresholds with data. Return an object containing any data that's above the threshold.
 */
function pastThresholds(wptData, thresholds) {
  var offenders = [];

  for (var i = 0; i < wptData.length; i++) {
    if (wptData[i] >= thresholds[i]) {
      offenders.push({
         name: DATA_POINTS[i].prettyName,
         units: DATA_POINTS[i].units,
         wptVal: wptData[i],
         thresholdVal: thresholds[i]
      });
    }
  }

  return offenders;
}


/**
 * Generate email text containing information about the url and the thresholds crossed.
 * Oh, for a templating system!
 */
function generateEmailBody(url, wptResultsURL, offenders) {
  offendingStrings = [];
      
  for (var i = 0; i < offenders.length; i++) {
    var unitsSpace = offenders[i].units ? ' ' : '';
    offendingStrings.push(
      'For <b>' +
      offenders[i].name + 
      '</b>, you set a threshold of ' +
      offenders[i].thresholdVal + 
      unitsSpace +
      offenders[i].units + 
      '. The tested value was <b>' +
      offenders[i].wptVal +
      unitsSpace +
      offenders[i].units +
      '</b>.'
    );
  }
  
Logger.log('Threshold violations mailed to user:'); Logger.log(offendingStrings);

  // Don't just return this, since if you follow "return" with a newline, JS will assume the statement is done.
  var retval =
    "Just wanted to let you know that your mobile site has exceeded some of the thresholds you set for " + 
    url +
    "<br/><br/>" +
    offendingStrings.join("<br/><br/>") +
    "<br/><br/><br/>" +
    "Full results can be seen at " +
    wptResultsURL
  ;
  
  return retval;
 }


 /******************************
 * HELPER FUNCTIONS            *
 ******************************/

/**
 * Store an array of strings in the spreadsheet for safekeeping.
 * Pad it to MAX_URLS.
 */
function saveTests(tests) {
  var crazyArray = [];
  for (var i = 0; i < tests.length; i++)
    crazyArray.push([tests[i].sheetName, tests[i].url]);
    
  for (i = 0; i < MAX_URLS - tests.length; i++)
    crazyArray.push(['', '']);

  var range = ss.getRangeByName(WPT_PENDING_TESTS);
  range.setValues(crazyArray);
};


/**
 * Remove a completed test from the list that we store in a scratch area of the spreadsheet.
 */
function removeTestFromPendingList(test) {
  var range = ss.getRangeByName(WPT_PENDING_TESTS);
  var values = range.getValues();
  for (var row = 0; row < values.length; row++)
    if (values[row][0] == test.sheetName)
      values[row] = ['', ''];
      
  Logger.log('in removeTestFromPendingList, setting: '); Logger.log(values);
  range.setValues(values);
}


function getTests() {
  var tests = [];
  var range = ss.getRangeByName(WPT_PENDING_TESTS);
  var values = range.getValues();
  for (var row = 0; row < range.length; row++)
    if (values[row][0])
      tests.push({
        sheetName: values[row][0],
        url: values[row][1]
      });

Logger.log('in getTests, returning: '); Logger.log(values);
  return tests;
}


/**
 * Combine parameters together into a URL query string.
 */
function buildQueryString(params) {
  var str = '';
  var cleanParamStrs = [];

  for (var o in params)
    cleanParamStrs.push(encodeURIComponent(o) + '=' + encodeURIComponent(params[o]));

  return cleanParamStrs.join('&');
}

// thank you, https://stackoverflow.com/questions/5717093/check-if-a-javascript-string-is-a-url
function isValidURL(url) {
  var pattern = new RegExp('^(https?:\\/\\/)?'+ // protocol
  '((([a-z\\d]([a-z\\d-]*[a-z\\d])*)\\.?)+[a-z]{2,}|'+ // domain name
  '((\\d{1,3}\\.){3}\\d{1,3}))'+ // OR ip (v4) address
  '(\\:\\d+)?(\\/[-a-z\\d%_.~+]*)*'+ // port and path
  '(\\?[;&a-z\\d%_.~+=-]*)?'+ // query string
  '(\\#[-a-z\\d_]*)?$','i'); // fragment locator
  
  return pattern.test(url);
}

// let's do a shallow copy of an object!
function copyObject(old) {
  var ret = {};
  
  for (var i in old)
    ret[i] = old[i];
    
  return ret;
}


// trim a string. (That isn't built into this version of ECMAScript.)
function trim(str) { Logger.log('in trim(), str is ' + str);
  return str.replace(/^\s+/, '').replace(/\s+$/, '');
}

/**
 * Starts a trigger to call pollForResults at a defined interval.
 * Checks for existing trigger. If it doesn't exist, create a new one.
 */

function startTrigger() {
  var props = PropertiesService.getUserProperties();
  var triggerId = props.getProperty(ss.getId());
  
  if (triggerId) {
    Logger.log('existing triggerId is ' + triggerId + '. Canceling.');
    cancelTrigger();
  }
        
  var trigger = ScriptApp.newTrigger("pollForResults").timeBased().everyMinutes(1).create();
  props.setProperty(ss.getId(), trigger.getUniqueId());
}


/**
 * Cancels trigger for onResults
 */

function cancelTrigger() {
  var props = PropertiesService.getUserProperties();
  var triggerId =  props.getProperty(ss.getId());
    
  props.deleteProperty(ss.getId());
      
  // Locate a trigger by unique ID
  var allTriggers = ScriptApp.getProjectTriggers();
  
  // Loop over all triggers
  for (var i = 0; i < allTriggers.length; i++) {
    if (allTriggers[i].getUniqueId() == triggerId) {
      // Found the trigger so now delete it
      ScriptApp.deleteTrigger(allTriggers[i]);
      break;
    }
  }
}  


/******************************
 * GETTER FUNCTIONS           *
 ******************************/

/**
 * Look for any sheets whose name begins with "URL".
 * Return array of "test" objects, which consist of those URLs and sheet names
 */
function getThingsToTest() {
  var sheets = ss.getSheets();
  var tests = [];

  for (var i = 0; i < sheets.length; i++) {
    var sheetName = sheets[i].getName();

    if (sheetName.slice(0, 3).toUpperCase() == 'URL') {
      var url = sheets[i].getRange(URL_CELL).getValue();

      if (url) {
        tests.push({
          sheetName: sheetName, url: url
        });
      }
      
      if (tests.length >= MAX_URLS)
        break;
    }
  }

  return tests;
}

/**
 * Retrieves WPT API key from Config tab
 */
function getAPIKey() {
  return ss.getRange(API_KEY).getValue();
}

/**
 * Get email addresses for alerting from spreadsheet. Omit blank lines.
 */
function getEmailRecipients() {
  var emails = [];
  
  var range = ss.getRangeByName(ALERT_EMAILS);
  var vals = range.getValues();
  for (var i = 0; i < vals.length; i++)
    if (vals[i][0])
      emails.push(vals[i][0]);

  return emails;
}

/**
 * Grab and store alert thresholds
 */
function getAlertThresholds() {
  var range = ss.getRangeByName(ALERT_THRESHOLDS);
  var data = range.getValues();
  return data[0];     // return the first row, which is our only row!
}

/**
 * Retrieve all tests fom the spreadsheet
 * Return an array of test objects (sheet name + URL)
 */
function getTests() {
  var range = ss.getRangeByName(WPT_PENDING_TESTS); 
  var crazyArray = range.getValues();
  var retval = [];

  for (var i = 0; i < crazyArray.length; i++)
    if (crazyArray[i][0])
      retval.push({
        sheetName: crazyArray[i][0],
        url: crazyArray[i][1]
      });

  return retval;
};
