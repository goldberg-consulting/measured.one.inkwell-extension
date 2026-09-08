/* global document */
import { startPreview } from './client.js';
const script = document.currentScript;
startPreview({ fontScale: Number(script.getAttribute('data-font-scale')) || 100,
  selectedTab: script.getAttribute('data-initial-tab') || 'preview',
  vendorRoot: script.getAttribute('data-vendor-root'), nonce: script.nonce });
