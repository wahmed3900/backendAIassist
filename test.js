process.env.SKIP_SIGNATURE_CHECK='true';
const { app, getBiz } = require('./server');
delete getBiz('+15550001111').aiMode; // test plain text-back mode
const s = app.listen(3999, async () => {
  const post = (p, b) => fetch('http://localhost:3999'+p,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(b)}).then(r=>r.text());
  const T='+15550001111', C='+15557776666', O='+15559998888';
  console.log('VOICE:', await post('/voice',{To:T,From:C}));
  console.log('MISSED:', await post('/call-status',{To:T,From:C,DialCallStatus:'no-answer'}));
  console.log('ANSWERED:', await post('/call-status',{To:T,From:C,DialCallStatus:'completed'}));
  await post('/sms',{To:T,From:C,Body:'My AC is broken'});
  await post('/sms',{To:T,From:O,Body:'We can come at 3pm'});
  s.close();
});
