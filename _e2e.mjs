import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 420, height: 880 } });
const log=(...a)=>console.log(...a);
try {
  await p.goto('http://localhost:3000/reports', { waitUntil:'networkidle' });
  await p.getByRole('heading', { name:'Assistant' }).first().waitFor();
  log('Assistant page OK');
  await p.getByText('Start a chat').click();
  await p.getByPlaceholder('Message the assistant').waitFor();
  log('new chat opened OK');
  await p.getByPlaceholder('Message the assistant').fill('what about oatmeal?');
  await p.getByRole('button', { name:'Send' }).click();
  await p.getByText('150 calories', { exact:false }).waitFor({ timeout:8000 });
  await p.getByText('Oatmeal (1 cup)').first().waitFor({ timeout:8000 });
  log('reply + action card OK');
  await p.getByRole('button', { name:'Confirm' }).click();
  await p.getByText('Logged', { exact:false }).waitFor({ timeout:8000 });
  log('confirm -> Logged OK');
  await p.getByRole('button', { name:'Close chat' }).click();
  await p.getByRole('button', { name:/what about oatmeal/ }).first().waitFor({ timeout:8000 });
  log('saved chat in Assistant list OK');
  await p.screenshot({ path:'/home/claude/hm-verify/list.png' });
  await p.getByRole('button', { name:/what about oatmeal/ }).first().click();
  await p.getByText('Hey! Oatmeal is about 150 calories.', { exact:false }).waitFor({ timeout:8000 });
  await p.getByText('Logged', { exact:false }).waitFor({ timeout:8000 });
  log('resume history (text + logged action) OK');
  await p.screenshot({ path:'/home/claude/hm-verify/resume.png' });
  log('SUCCESS');
} catch(e){ log('FAIL:', e.message); await p.screenshot({path:'/home/claude/hm-verify/fail.png'}).catch(()=>{}); process.exitCode=1; }
finally { await b.close(); }
