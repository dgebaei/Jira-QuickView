/*global chrome */
import {waitForDocument} from 'src/utils';

waitForDocument(() => require('src/snack.scss'));

let activeSnackElement = null;
let activeSnackTimer = null;

function getOrCreateSnack() {
  const $ = require('jquery');
  if (activeSnackElement && activeSnackElement.length) {
    return activeSnackElement;
  }

  activeSnackElement = $(`
      <div class="_JX_snack">
          <div class="_JX_snack_icon">
            <img src="${chrome.runtime.getURL('resources/jiralink128.png')}" class="_JX_snack_icon_img" />
          </div>
          <div class="_JX_snack_message"></div>
      </div>
  `);
  $(document.body).append(activeSnackElement);
  return activeSnackElement;
}

export function snackBar(message, timeout = 6000) {
  const content = getOrCreateSnack();
  content.find('._JX_snack_message').text(message || '');
  content.addClass('_JX_snack_show');

  if (activeSnackTimer) {
    clearTimeout(activeSnackTimer);
  }

  activeSnackTimer = setTimeout(function () {
    content.removeClass('_JX_snack_show');
    activeSnackTimer = null;
  }, timeout);
}
