import type { DesktopAPI } from '../shared/contracts/ipc';
declare global { interface Window { dataAgent: DesktopAPI } }
