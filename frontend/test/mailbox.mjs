/** Fetch only synthetic test recipients from a loopback Mailpit inbox. Never log email tokens. */
export async function mailLink(email,subject,route,{mailbox=process.env.MAILBOX_URL??'http://localhost:58026',after=0}={}) {
  const url=new URL(mailbox);
  if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new Error('Tests require a loopback mailbox');
  const deadline=Date.now()+25000;
  while(Date.now()<deadline){
    const response=await fetch(`${mailbox}/api/v1/messages?limit=100`);
    if(!response.ok)throw new Error('Local mailbox unavailable');
    const list=await response.json();
    const match=list.messages.find(m=>m.Subject.includes(subject) && m.To.some(t=>t.Address.toLowerCase()===email.toLowerCase()) && (!after || Date.parse(m.Created)>=after));
    if(match){
      const detail=await(await fetch(`${mailbox}/api/v1/message/${match.ID}`)).json();
      const link=detail.Text?.match(/https?:\/\/[^\s<>]+/)?.[0];
      if(link && new URL(link).pathname===route)return link;
    }
    await new Promise(r=>setTimeout(r,250));
  }
  throw new Error('Expected local test email was not delivered');
}
