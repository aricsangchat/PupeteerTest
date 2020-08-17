const fs = require('fs');
const puppeteer = require('puppeteer');
let page = null;
let browser = null;

fs.readFile('otherCredentials.json', (err, data) => {
    if (err) return console.log('Error loading otherCredentials.json:', err);
    otherCredentials = JSON.parse(data);
    initiateWorkFlow(otherCredentials);
});

const initiateWorkFlow = async (etsyCredentials) => {
    browser = await puppeteer.launch({ 
        headless: false,
        slowMo: 150,
        args: [
            '--disable-notifications',
            '--disable-extensions-except=../../../../../../AliAddressAutoFill/extension',
            '--load-extension=../../AliAddressAutoFill/extension/',
        ],
        defaultViewport: null,
        userDataDir: "./user_data"
     });
    // Open a new page and navigate to etsy.com
    page = await browser.newPage();

    await Promise.all([
        page.waitForNavigation(),
        page.goto('https://etsy.com')
        
    ]);
    const loggedin = await page.evaluate(() => {
        return document.querySelectorAll('.account-nav').length;
    });
    // Check if logged in
    if (loggedin > 0) {
        // continue to orders page
        processOrders(page);
    } else {
        // login
        login(page);
    }
}

const login = async (page) => {
    // Wait
    await new Promise(resolve => setTimeout(resolve, 500));
    // Click on sign in button
    await page.click('#gnav-header-inner > div.wt-flex-shrink-xs-0 > nav > ul > li:nth-child(1) > button', {
        delay: 200
    });
    // Wait for login modal
    try {
        await page.waitForSelector('#join_neu_email_field', {
          timeout: 5000
        })
    } catch (e) {
        if (e instanceof puppeteer.errors.TimeoutError) {
          console.log(e);
        }
    }
    // Enter Email Address
    await page.type('#join_neu_email_field', otherCredentials.etsy.userName, { delay: 100 });
    // Wait
    await new Promise(resolve => setTimeout(resolve, 300));
    // Enter Password
    await page.type('#join_neu_password_field', otherCredentials.etsy.password, { delay: 100 });
    // Wait
    await new Promise(resolve => setTimeout(resolve, 500));
    // Keypress Enter, Wait for page reload,
    // navigate to orders page, wait for page load
    await page.keyboard.press('Enter');

    await Promise.all([
        page.waitForNavigation()
    ]);
    await new Promise(resolve => setTimeout(resolve, 700));
}

const loginAliExpress = async (resolve) => {
    aliPage = await browser.newPage();
    // Sign In
    await aliPage.goto('https://aliexpress.com');
    // Wait 5 Seconds
    await new Promise(resolve => setTimeout(resolve, 5000));
    // Close Popup
    try {
        await aliPage.click('.close-layer');
    } catch (e) {
        if (e instanceof puppeteer.errors.TimeoutError) {
            // Do something if this is a timeout.
            console.log(e);
        }
    }

    let signInText = await aliPage.evaluate(() => document.querySelector('.flyout-sign-out a').innerText);
    console.log(signInText);
    if (signInText !== 'Sign Out') {
        // Wait 5 Seconds
        await new Promise(resolve => setTimeout(resolve, 5000));
        // Click Sign In Button
        await aliPage.click('.register-btn a');
        // Wait 5 Seconds
        await new Promise(resolve => setTimeout(resolve, 8000));
        // Select Login Form from within Iframe
        const loginIframeElement = await aliPage.$('iframe[id="alibaba-login-box"]');
        const loginIframeContent = await loginIframeElement.contentFrame();
        // Fill in Username
        await loginIframeContent.type('#fm-login-id', otherCredentials.ali.username, { delay: 100 });
        // Fill in Password
        await loginIframeContent.type('#fm-login-password', otherCredentials.ali.password, { delay: 100 });
        // Wait 1 second
        await new Promise(resolve => setTimeout(resolve, 1000));
        // Keypress Enter
        await aliPage.keyboard.press('Enter');
        await new Promise(resolve => setTimeout(resolve, 5000));
        await aliPage.close();
        return resolve();
    } else {
        // Already signed in
        await new Promise(resolve => setTimeout(resolve, 5000));
        await aliPage.close();
        return resolve();
    }
}

const processOrders = async (page) => {
    await Promise.all([
        page.waitForNavigation(),
        page.goto('https://www.etsy.com/your/orders/sold')
        
    ]);
    await new Promise(resolve => setTimeout(resolve, 700));
    // Wait for orders to load and ali extension to initialize
    await new Promise(resolve => setTimeout(resolve, 10000));
    // Grab Orders Object
    const orders = await page.$$('.orders-full-width-panel-on-mobile .flag-body .col-xs-12');
    console.log(orders.length);
    // Loop through each order
    for (let index = 0; index < orders.length; index++) {
        // Open Order
        await orders[index].click();
        // Wait for Ai Extension to Initialize
        await new Promise(resolve => setTimeout(resolve, 4000));
        // Check if its an AliExpress Order
        let aliFlag = true;
        try {
            await page.waitForSelector('#order-detail-container > div.pt-xs-2.pb-xs-4 > div > div > div > table > tbody > tr.col-group.pl-xs-0.pt-xs-3.pr-xs-0.pb-xs-3.bb-xs-1 > a', {
              timeout: 5000
            })
        } catch (e) {
            if (e instanceof puppeteer.errors.TimeoutError) {
              console.log('isnt ali product');
              aliFlag = false;
            }
        }
        // Is an aliexpress order
        if (aliFlag) {
            // login to aliexpress
            await new Promise(resolve => loginAliExpress(resolve));
            // go to product page on aliexpress
            await page.click('#order-detail-container > div.pt-xs-2.pb-xs-4 > div > div > div > table > tbody > tr.col-group.pl-xs-0.pt-xs-3.pr-xs-0.pb-xs-3.bb-xs-1 > a');
            
        } // else continue to next order.
        await page.click('#root > div > div:nth-child(3) > div > div.position-fixed.height-full.position-top.position-left.width-full > div.peek-overlay.col-md-9.col-lg-7.col-xl-6.bg-gray.animated.position-absolute.position-top.position-right.pr-xs-0.pl-xs-0.height-full.animated-slide-in-left > button > span.etsy-icon');
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    

    
    console.log('done')
}
