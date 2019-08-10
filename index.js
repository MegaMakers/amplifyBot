const { App } = require('@slack/bolt');
const twitter = require('twitter');

var twitterClient = new twitter({
  consumer_key: process.env.TWITTER_CONSUMER_KEY,
  consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
  access_token_key: process.env.TWITTER_ACCESS_TOKEN_KEY,
  access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET
});

// Pipeline methods
// All receive params:{context, body, payload, event, message, say, next}
// And need to return params if the pipeline is to continue

const filterChannelJoins = await function(params) {
  if (params.message.subtype && params.message.subtype === 'channel_join') return;
  return params;
}

var lastPosted = {}; // TODO: ideally move to a db
const checkUserPostLimits = function(validDelay) {
  let checkSpecifiedUserPostLimits = function(params) {
    let userId = params.message.user;
    let now = new Date();
    if (lastPosted[userId]) {
      if (now - lastPosted[userId] < validDelay) return;
    }
    lastPosted[userId] = now;
    return params;
  }
  return checkSpecifiedUserPostLimits;
}

const printDbg = await function(params) {
  console.log('Debug - message:', params.message);
  return params;
}

const letUserKnow = await function(params) {
  let msgToTweet = params.message.text;
  msgToTweet = msgToTweet.replace(/:twitter:/,'')

  params.say(`Hey there <@${params.message.user}>! - I will tweet ${msgToTweet}`);

  return params;
}

const tweet = async await function(params) {
  let msgToTweet = params.message.text;
  msgToTweet = msgToTweet.replace(/:twitter:/,'')

  let tweetRet = await twitterClient.post('statuses/update', {status: msgToTweet});
  console.log(`Tweeted: ${msgToTweet} - Received: `, tweetRet);

  return params;
}

// Initialize app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET
});


const messageProcessingPipeline = [
  filterChannelJoins,
  checkUserPostLimits(1000 * 60 * 1), // 1 min
  printDbg,
  letUserKnow,
  tweet
];


app.message(async (params) => {

  console.log('==> Received message notification');
  for (let processor of messageProcessingPipeline) {
    console.log(`==> Processing with processor: ${processor.name}`)
    params = await processor(params);
    if (!params) return;
  }

});

// Start the app
(async () => {
  const appPort = process.env.PORT || 3000;
  await app.start(appPort);

  console.log(`App is running at ${appPort}`);
})();
