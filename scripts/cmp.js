require('dotenv').config({ override: true });
const { getRelevantChunks } = require('../lib/hybrid_retrieval');
const norm = s => String(s||'').replace(/\s+/g,' ');
(async () => {
  const queries = [
    ['WITH community name (what Claire sends)', 'Hi, Can you please tell me how many people the Waterview Estates clubhouse can accommodate? Thank you!'],
    ['WITHOUT community name (what askEd sends)', 'how many people can the clubhouse accommodate? maximum capacity'],
  ];
  for (const [label,q] of queries) {
    const t = norm((await getRelevantChunks(q, 'Waterview Estates')) || '');
    const i = t.search(/limit the size of any gathering|not more than 50 people/i);
    console.log(`\n${label}\n   -> capacity answer: ${i>=0?'FOUND @'+i:'NOT FOUND'}`);
  }
})().catch(e=>{console.error(e.message)});
