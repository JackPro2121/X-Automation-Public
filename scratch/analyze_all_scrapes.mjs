import fs from 'fs';

const files = [
  'scratch/danellisona_scrape.json',
  'scratch/danellisona_top.json',
  'scratch/danellisona_viral_50.json',
  'scratch/danellisona_older.json',
];

const tweetMap = new Map();

for (const file of files) {
  if (fs.existsSync(file)) {
    const items = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const item of items) {
      if (item.id && !tweetMap.has(item.id)) {
        tweetMap.set(item.id, item);
      }
    }
  }
}

const tweets = Array.from(tweetMap.values()).sort((a, b) => (b.likeCount || 0) - (a.likeCount || 0));

console.log(`=======================================================`);
console.log(`TOTAL UNIQUE TWEETS HARVESTED: ${tweets.length}`);
console.log(`=======================================================\n`);

tweets.forEach((t, i) => {
  console.log(`-------------------------------------------------------`);
  console.log(`RANK #${i + 1} | ID: ${t.id} | Date: ${t.createdAt}`);
  console.log(`Likes: ${t.likeCount} | RT: ${t.retweetCount} | Bookmarks: ${t.bookmarkCount} | Replies: ${t.replyCount || 'N/A'} | Views: ${t.viewCount || 'N/A'}`);
  console.log(`URL: ${t.url}`);
  console.log(`Media: ${(t.media || []).map(m => m.type).join(', ') || 'None'}`);
  console.log(`Text:\n${t.text}\n`);
});
