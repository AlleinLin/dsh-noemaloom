import * as React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { DelayedMessageButton } from '../../src/client/DelayedMessageButton.js';

let pending = 0, maximumPending = 0, calls = 0;
const api: any = {
  async call() {
    calls++;
    maximumPending = Math.max(maximumPending, ++pending);
    await new Promise(done => setTimeout(done, 2200));
    pending--;
    return [{ id: 'slow-plan', revision: 1, value: {
      sessionId: 'slow-child', schedule: 'delay', delayMinutes: 1,
      status: 'completed', body: 'slow response still updates this child',
      dueAt: new Date(0).toISOString(), createdAt: new Date(0).toISOString(),
    } }];
  },
};
flushSync(() => createRoot(document.getElementById('root')!).render(
  <DelayedMessageButton api={api} sessionId="slow-child" />,
));
document.querySelector<HTMLButtonElement>('[aria-label="延时发送固定文字"]')!.click();
setTimeout(() => {
  const value = { delivered: document.body.innerText.includes('已送达'), calls, maximumPending };
  document.body.setAttribute('data-delayed-fixture', btoa(JSON.stringify(value)));
}, 7000);
