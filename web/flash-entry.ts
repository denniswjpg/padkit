// SPDX-License-Identifier: MIT

import { mountWizard } from './src/flash-wizard.ts';
import { padMeter } from './src/meters.ts';

const root = document.getElementById('flasher');
if (root) {
  mountWizard(root, {
    configUrl: './config.html',
    meter: padMeter,
    photos: [
      { src: './img/PadKit_screws.webp', caption: 'Four screws in the corners of the faceplate.' },
      { src: './img/PadKit_device_opened.webp', caption: 'Board lifted out. SW2 is next to the U7 chip.' },
      { src: './img/PadKit_short_pincett.webp', caption: 'Bridge SW2, then plug in the cable.' },
    ],
  });
}
