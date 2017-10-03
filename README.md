# speedcheck
An Apps Script that polls Webpagetest weekly and puts the result into a Google Sheet. If metrics exceed your thresholds, you'll get an email.  A great way to make sure your site doesn't slow down!

This is meant to be used in the Google Sheet at https://goo.gl/SgMfGc.

Here's how it works:
1. You create a tab in the trix for each URL whose speed you want to track.
1. Once a week, the tool runs Webpagetest on each of those URLs.
1. The tool retrieves key performance metrics from those tests, placing those in a new row in each tab.
1. If any metric exceeds thresholds you’ve set, it sends alerts to email addresses also stored in the trix.

That’s it!



## Setup:
1) Make your own copy of the Sheet.

2) Get your own API key for all your copies of this tool.
* get an API key from Webpagetest by filling out the simple form [here](https://www.webpagetest.org/getkey.php).
* Go to the hidden “Config” sheet.
* Replace the API key in cell B1 with your own.
* Hide that sheet if you'd like.
 
(Otherwise, you’ll be using my key, and they’re only good for 200 tests per day.  You’re not liable to ever hit this limit, but if everyone shares my key, this will get reached indeed.)

3) Specify your URLs. 
* In the “URL 1” tab, replace the URL in column B1 with the URL you want tested.
* If you want to test more URLs, copy the “URL 1” tab.  You can test as many as 10 URLs.  Just make sure that the name of each tab starts with “URL”.

4) Enter desired email addresses in the “Alerting” tab.

5) Set up weekly tests:
* Under the “Tools” menu, select “Script Editor”.  A new browser tab will open.
* In that new tab, go to the “Edit” menu and choose “Current project’s triggers”.
* In the popup window, click on “Add a new trigger”, and set it up as shown (weekly tests are recommended, but you can decide)


That’s it!  Enjoy!
