require('dotenv').config();
console.log('🚀 Viagogo Price Monitor starting...');

const { connect } = require('puppeteer-real-browser');
const { createClient } = require('@supabase/supabase-js');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

const randomDelay = (min, max) => {
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

const CONFIG = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  DISCORD_CHANNEL_ID: process.env.DISCORD_CHANNEL_ID,
  ARTIST_FILTER: process.env.ARTIST_FILTER,
  COUNTRY_FILTER: process.env.COUNTRY_FILTER,
  PROJECT_NAME: process.env.PROJECT_NAME || 'viagogo-monitor',
  PRICE_DROP_THRESHOLD: 0.60, // 60%
  JSON_FILE_NAME: process.env.JSON_FILE_NAME || 'viagogo-data.json',
  STORAGE_BUCKET: process.env.STORAGE_BUCKET || 'scraper-data',
};

console.log(`📁 Config: ${CONFIG.STORAGE_BUCKET}/${CONFIG.JSON_FILE_NAME}`);
console.log(`🎯 Filters: Artist="${CONFIG.ARTIST_FILTER || 'ALL'}", Country="${CONFIG.COUNTRY_FILTER || 'ALL'}"`);
console.log(`📉 Alert threshold: ${CONFIG.PRICE_DROP_THRESHOLD * 100}%\n`);

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
];

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * Upload JSON to Supabase Storage
 */
async function uploadJsonToStorage(supabase, fileName, jsonData) {
  try {
    console.log(`📤 Uploading ${fileName} to Storage...`);
    
    const jsonString = JSON.stringify(jsonData, null, 2);
    const buffer = Buffer.from(jsonString, 'utf-8');
    
    const { error } = await supabase.storage
      .from(CONFIG.STORAGE_BUCKET)
      .upload(fileName, buffer, {
        contentType: 'application/json',
        upsert: true
      });
    
    if (error) {
      console.error(`   ❌ Upload failed:`, error.message);
      return false;
    }
    
    console.log(`   ✅ Uploaded successfully`);
    return true;
    
  } catch (error) {
    console.error(`   ❌ Upload error:`, error.message);
    return false;
  }
}

/**
 * Extract event details from page (for Discord embed)
 */
async function getEventDetails(page) {
  try {
    return await page.evaluate(() => {
      const pageTitle = document.querySelector('title')?.textContent?.trim() || 'Unknown Event';
      
      const imageSelectors = [
        'meta[property="og:image"]',
        'meta[name="twitter:image"]',
      ];
      
      let eventImage = null;
      for (const selector of imageSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          const imageUrl = element.getAttribute('content');
          if (imageUrl && imageUrl.startsWith('http')) {
            eventImage = imageUrl;
            break;
          }
        }
      }

      return {
        name: pageTitle,
        image: eventImage
      };
    });
  } catch (error) {
    console.warn('⚠️ Could not extract event details:', error.message);
    return {
      name: 'Unknown Event',
      image: null
    };
  }
}

/**
 * Send Discord notification for price drop
 */
async function sendDiscordNotification(
  discordChannel, 
  eventName,
  eventImage,
  sectionData, 
  oldPrice, 
  newPrice, 
  ticketCount, 
  url
) {
  if (!discordChannel) {
    console.warn('⚠️ Discord not configured, skipping notification');
    return;
  }
  
  const percentageDrop = (((oldPrice - newPrice) / oldPrice) * 100).toFixed(1);
  
  try {
    const embed = new EmbedBuilder()
      .setTitle('🎫 Price Drop Alert!')
      .setColor(0x00ff00)
      .addFields(
        { name: 'Event', value: eventName, inline: false },
        { name: 'Section', value: sectionData.sectionName, inline: true },
        { name: 'Row', value: sectionData.rowId ? `${sectionData.rowId}` : 'N/A', inline: true },
        { name: 'Tickets', value: `${ticketCount}`, inline: true },
        { name: 'Old Price', value: `€${oldPrice.toFixed(2)}`, inline: true },
        { name: 'New Price', value: `€${newPrice.toFixed(2)}`, inline: true },
        { name: 'Drop', value: `${percentageDrop}%`, inline: true }
      )
      .setURL(url)
      .setTimestamp();

    if (eventImage) {
      embed.setThumbnail(eventImage);
    }

    await discordChannel.send({ embeds: [embed] });
    console.log('   ✅ Discord notification sent');
  } catch (error) {
    console.error('   ❌ Discord notification failed:', error.message);
  }
}

/**
 * Extract sections and prices from JSON
 */
function extractSectionsFromJSON(jsonData) {
  console.log('🎯 Parsing sections from JSON...');
  
  try {
    let venueConfiguration = null;
    let rowPopupData = null;
    
    // Try different JSON structures
    if (jsonData.grid?.venueMapData?.venueConfiguration) {
      venueConfiguration = jsonData.grid.venueMapData.venueConfiguration;
      rowPopupData = jsonData.grid.venueMapData.rowPopupData || {};
      console.log('   ✅ Found in grid.venueMapData');
    } else if (jsonData.venueConfiguration) {
      venueConfiguration = jsonData.venueConfiguration;
      rowPopupData = jsonData.rowPopupData || {};
      console.log('   ✅ Found in root');
    } else if (jsonData.dataSourceResults?.venueConfiguration) {
      venueConfiguration = jsonData.dataSourceResults.venueConfiguration;
      rowPopupData = jsonData.dataSourceResults.rowPopupData || {};
      console.log('   ✅ Found in dataSourceResults');
    }
    
    if (!venueConfiguration) {
      console.error('   ❌ venueConfiguration not found in JSON');
      return [];
    }
    
    const sections = [];
    
    for (const sectionKey in venueConfiguration) {
      const section = venueConfiguration[sectionKey];
      const sectionId = section.id;
      const sectionName = section.name || `Section ${sectionId}`;
      
      for (const rowKey in section.rows || {}) {
        const row = section.rows[rowKey];
        const rowId = row.id;
        const popupKey = `${sectionId}-${rowId}`;
        const popupData = rowPopupData[popupKey];
        
        if (!popupData?.sellPrice) continue;
        
        const ticketCount = popupData.ticketCount || 1;
        const priceFormatted = popupData.sellPrice;
        const priceMatch = priceFormatted.match(/[\d.,]+/);
        
        if (!priceMatch) continue;
        
        const price = parseFloat(priceMatch[0].replace(',', ''));
        const combinationKey = `${sectionName}-${rowId}`;
        
        sections.push({
          combinationKey,
          sectionId,
          sectionName,
          rowId,
          price,
          ticketCount
        });
      }
    }
    
    console.log(`   ✅ Extracted ${sections.length} section-row combinations\n`);
    return sections;
    
  } catch (error) {
    console.error('   ❌ Parse error:', error.message);
    return [];
  }
}

/**
 * Main scraping function
 */
async function scrapeEvent(url, linkId, linkData, supabase, discordChannel) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🎫 Processing: ${linkData.name || url}`);
  console.log(`${'='.repeat(60)}\n`);
  
  let browser = null;
  let scrapedJsonData = null;
  
  try {
    const { browser: connectedBrowser, page } = await connect({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1920,1080',
      ],
      turnstile: true,
      customConfig: {},
      connectOption: {
        defaultViewport: { width: 1920, height: 1080 }
      },
      disableXvfb: false,
      ignoreAllFlags: false
    });
    
    browser = connectedBrowser;
    await page.setUserAgent(getRandomUserAgent());
    console.log('✅ Browser initialized');

    // Intercept JSON from page
    let htmlIntercepted = false;
    
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      request.continue();
    });

    page.on('response', async (response) => {
      const respUrl = response.url();
      
      if (respUrl.includes('/event/') && 
          response.request().resourceType() === 'document' && 
          !htmlIntercepted) {
        try {
          const html = await response.text();
          const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
          
          if (match) {
            scrapedJsonData = JSON.parse(match[1]);
            htmlIntercepted = true;
            console.log('   ✅ JSON intercepted from page');
          }
        } catch (error) {
          console.log(`   ⚠️ JSON intercept failed: ${error.message}`);
        }
      }
    });

    console.log('🌐 Navigating to page...');
    console.log(url);
    await page.goto(url, { 
      waitUntil: 'domcontentloaded',
      timeout: 60000 
    });
    
    console.log('✅ Page loaded');
    await randomDelay(8000, 12000);

    // Get event details for Discord
    const eventDetails = await getEventDetails(page);
    console.log(`📋 Event: ${eventDetails.name}`);

    // Upload JSON to Supabase Storage
    if (scrapedJsonData) {
      await uploadJsonToStorage(supabase, CONFIG.JSON_FILE_NAME, scrapedJsonData);
    } else {
      console.warn('⚠️ No JSON data scraped from page');
      await browser.close();
      return { success: false, reason: 'No JSON data' };
    }

    // Parse sections from JSON
    const sections = extractSectionsFromJSON(scrapedJsonData);
    
    if (sections.length === 0) {
      console.error('❌ No sections found in JSON');
      await browser.close();
      return { success: false, reason: 'No sections' };
    }

    // Load previous prices from vgg_links
    const previousPrices = linkData.previousprices || {};
    console.log(`📊 Comparing with ${Object.keys(previousPrices).length} previous prices...`);

    // Check for price drops
    let priceDropsFound = 0;
    const newPrices = {};

    for (const section of sections) {
      const { combinationKey, sectionName, rowId, price, ticketCount } = section;
      
      newPrices[combinationKey] = price;
      const oldPrice = previousPrices[combinationKey];
      
      if (oldPrice && price < oldPrice) {
        const dropPercentage = ((oldPrice - price) / oldPrice);
        
        if (dropPercentage >= CONFIG.PRICE_DROP_THRESHOLD) {
          console.log(`\n🔥 PRICE DROP DETECTED!`);
          console.log(`   ${sectionName} Row ${rowId}`);
          console.log(`   €${oldPrice.toFixed(2)} → €${price.toFixed(2)} (-${(dropPercentage * 100).toFixed(1)}%)`);
          
          priceDropsFound++;
          
          await sendDiscordNotification(
            discordChannel,
            eventDetails.name,
            eventDetails.image,
            section,
            oldPrice,
            price,
            ticketCount,
            url
          );
        }
      }
    }

    // Update vgg_links with new prices
    const { error: updateError } = await supabase
      .from('vgg_links')
      .update({ 
        previousprices: newPrices,
        last_checked: new Date().toISOString()
      })
      .eq('id', linkId);
    
    if (updateError) {
      console.error('\n❌ Error updating vgg_links:', updateError.message);
    } else {
      console.log(`\n✅ Updated previousprices in vgg_links (${Object.keys(newPrices).length} combinations)`);
    }

    console.log(`\n📊 Summary:`);
    console.log(`   Sections checked: ${sections.length}`);
    console.log(`   Price drops (≥60%): ${priceDropsFound}`);

    await browser.close();
    return { success: true, priceDropsFound };
    
  } catch (error) {
    console.error('\n❌ Scraping error:', error.message);
    if (browser) await browser.close();
    return { success: false, reason: error.message };
  }
}

/**
 * Main function
 */
async function main() {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );

  // Initialize Discord
  let discordClient = null;
  let discordChannel = null;

  if (CONFIG.DISCORD_TOKEN && CONFIG.DISCORD_CHANNEL_ID) {
    try {
      discordClient = new Client({ intents: [GatewayIntentBits.Guilds] });
      await discordClient.login(CONFIG.DISCORD_TOKEN);
      discordChannel = await discordClient.channels.fetch(CONFIG.DISCORD_CHANNEL_ID);
      console.log('✅ Discord initialized\n');
    } catch (error) {
      console.error('❌ Discord initialization failed:', error.message);
      console.log('⚠️ Continuing without Discord notifications\n');
    }
  } else {
    console.warn('⚠️ Discord not configured - notifications disabled\n');
  }

  try {
    console.log(`${'='.repeat(60)}`);
    console.log('🔄 Starting price monitoring cycle...');
    console.log(`${'='.repeat(60)}\n`);

    // Build query with filters
    let query = supabase
      .from('vgg_links')
      .select('id, url, name, artist, country, previousprices, last_checked')
      .not('url', 'is', null);

    if (CONFIG.ARTIST_FILTER) {
      query = query.ilike('artist', `%${CONFIG.ARTIST_FILTER}%`);
    }
    if (CONFIG.COUNTRY_FILTER) {
      query = query.ilike('country', `%${CONFIG.COUNTRY_FILTER}%`);
    }

    const { data: links, error: linksError } = await query;

    if (linksError) {
      console.error('❌ Error fetching links:', linksError.message);
      process.exit(1);
    }

    if (!links || links.length === 0) {
      console.log('⚠️ No links found matching filters');
      process.exit(0);
    }

    console.log(`📋 Found ${links.length} link(s) to check\n`);

    // Process each link
    let totalDrops = 0;
    for (const link of links) {
      const result = await scrapeEvent(link.url, link.id, link, supabase, discordChannel);
      if (result.success) {
        totalDrops += result.priceDropsFound;
      }
      
      // Random delay between links
      if (links.length > 1) {
        await randomDelay(10000, 20000);
      }
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log('✅ Monitoring cycle completed');
    console.log(`📊 Total price drops found: ${totalDrops}`);
    console.log(`${'='.repeat(60)}\n`);
    
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run
main().catch(error => {
  console.error('❌ Unhandled error:', error.message);
  console.error(error.stack);
  process.exit(1);
});