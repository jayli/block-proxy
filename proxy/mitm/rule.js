const YoutubeResponse = require('./youtube/youtube.response.js');

module.exports = {
  Youtube: [
    // Rule1
    {
      'type': 'beforeSendResponse',
      'host': 'xxxx.youtubei.googleapis.com',
      'regexp': "\/youtubei\/v1\/(browse|next|player|search|reel\/reel_watch_sequence|guide|account\/get_setting|get_watch)",
      'callback': async function(url, request, response) {
        return null;

        var responseResult = {};
        console.log('!!!!!!!!!!!!!!!!!!!!!!', url, responseDetail.response);
        Youtube.injection({
          callback: function(obj) {
            responseResult = obj;
          },
          url: url,
          response: responseDetail.response,
          request: request
        });
        Youtube.main();
        console.log('OOOOOOOOOOKKKKKKKKKKKK', responseResult);

      } // -- callback
    },
    // Rule2...
    {
      type: "beforeSendRequest",
      host: "googlevideo.com",
      regexp: "(^https?:\/\/[\\w-]+\.googlevideo\.com\/.+)(ctier=L)(&.+)",
      callback: async function(url, request, response) {
        const matchRegExp = new RegExp(this.regexp);
        const matchResult = url.match(matchRegExp);
        if (matchResult !== null) {
          const newUrl = matchResult[1] + matchResult[3];
          console.log(`302 ---------------- ${newUrl}`);
          return {
            response: {
              statusCode: 302,
              header: {
                'Location': newUrl,
                'Content-Length': '0'
              },
              body: Buffer.alloc(0)
            }
          };
        }
      } // -- callback
    }
  ]
};
