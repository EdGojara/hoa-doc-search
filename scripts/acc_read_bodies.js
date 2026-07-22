require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const s = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const EMAILS = ['cooperandrea1@icloud.com', 'juanmedina57@gmail.com'];
(async () => {
  for (const em of EMAILS) {
    const { data, error } = await s.from('email_messages')
      .select('id, graph_id, mailbox, conversation_id, subject, received_at, has_attachments, body_preview, body_full, ai_summary')
      .ilike('sender_email', em).order('received_at', { ascending: true });
    if (error) { console.log(em, 'ERR', error.message); continue; }
    console.log('\n============== ' + em + ' ==============');
    for (const r of data) {
      console.log(`\n--- ${String(r.received_at).slice(0,16)} | "${r.subject}" | att=${r.has_attachments} | mailbox=${r.mailbox} | conv=${(r.conversation_id||'').slice(0,16)}`);
      console.log(`    graphId=${r.graph_id ? r.graph_id.slice(0,24)+'…' : '(none)'}`);
      const body = (r.body_full || r.body_preview || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      console.log('    BODY: ' + body.slice(0, 400));
      if (r.ai_summary) console.log('    AI: ' + r.ai_summary.slice(0, 200));
    }
  }
})();
