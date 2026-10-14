import fs from 'fs';

const data = JSON.parse(fs.readFileSync('scratch/danellisona_scrape.json', 'utf8'));
console.log('Total items fetched:', data.length);

if (data.length > 0) {
  const first = data[0];
  console.log('--- Profile Info ---');
  console.log('Name:', first.author?.name);
  console.log('UserName:', first.author?.userName);
  console.log('Bio:', first.author?.description);
  console.log('Followers:', first.author?.followers);
  console.log('Following:', first.author?.following);
  console.log('Media Count:', first.author?.mediaCount);
  console.log('Statuses Count:', first.author?.statusesCount);
  console.log('Location:', first.author?.location);
  console.log('URL in bio:', first.author?.url);

  console.log('\n--- Tweets Breakdown ---');
  data.forEach((t, i) => {
    console.log(`\n[#${i + 1}] Date: ${t.createdAt} | Likes: ${t.likeCount} | RT: ${t.retweetCount} | Bookmarks: ${t.bookmarkCount} | Views: ${t.viewCount || 'N/A'}`);
    console.log('Media:', (t.media || []).map(m => m.type).join(', ') || 'None');
    console.log('URL:', t.url);
    console.log('Text:\n' + t.text);
  });
}
