import type { CerebroAPI } from './ipc';

declare global {
  interface Window {
    cerebro: CerebroAPI;
  }
}
