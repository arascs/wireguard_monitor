import { useState } from 'react';
import Alerts from './Alerts';
import OperationLogs from './OperationLogs';

export default function Logging() {
  const [tab, setTab] = useState('alerts');

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold text-zinc-900">Logging</h1>

      <div className="flex flex-wrap gap-2 border-b border-zinc-200 pb-2">
        <button
          type="button"
          className={`px-4 py-2 text-sm rounded-t-md border-b-2 -mb-px transition-colors ${
            tab === 'alerts'
              ? 'border-primary text-primary font-medium bg-white'
              : 'border-transparent text-zinc-600 hover:text-zinc-900'
          }`}
          onClick={() => setTab('alerts')}
        >
          Alerts
        </button>
        <button
          type="button"
          className={`px-4 py-2 text-sm rounded-t-md border-b-2 -mb-px transition-colors ${
            tab === 'op'
              ? 'border-primary text-primary font-medium bg-white'
              : 'border-transparent text-zinc-600 hover:text-zinc-900'
          }`}
          onClick={() => setTab('op')}
        >
          Operation logs
        </button>
      </div>

      {tab === 'alerts' && <Alerts />}
      {tab === 'op' && <OperationLogs />}
    </div>
  );
}
