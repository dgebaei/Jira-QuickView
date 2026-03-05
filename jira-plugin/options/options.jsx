/*global chrome */
import defaultConfig from 'options/config';
import ReactDOM from 'react-dom';
import {storageGet, storageSet, permissionsRequest} from 'src/chrome';
import {hasPathSlash, resetDeclarativeMapping, toMatchUrl} from 'options/declarative';

import 'options/options.scss';

const errorText = document.createElement('div');
document.body.appendChild(errorText);
window.onerror = function (msg, file, line, column, error) {
  errorText.textContent = (error && error.stack) ? error.stack : String(msg || 'Unknown error');
};

const FIELD_OPTIONS = [
  {key: 'issueType', label: 'Issue Type'},
  {key: 'status', label: 'Status'},
  {key: 'priority', label: 'Priority'},
  {key: 'sprint', label: 'Sprint'},
  {key: 'fixVersions', label: 'Fix Version'},
  {key: 'affects', label: 'Affects Version'},
  {key: 'labels', label: 'Labels'},
  {key: 'account', label: 'Account'},
  {key: 'epicParent', label: 'Epic/Parent'},
  {key: 'attachments', label: 'Attachments'},
  {key: 'comments', label: 'Comments'},
  {key: 'description', label: 'Description'},
  {key: 'reporter', label: 'Reporter'},
  {key: 'assignee', label: 'Assignee'},
  {key: 'pullRequests', label: 'Related Pull Requests'}
];

function getDisplayFieldValuesFromForm() {
  const values = {};
  FIELD_OPTIONS.forEach(({key}) => {
    const node = document.getElementById(`displayField_${key}`);
    values[key] = !!(node && node.checked);
  });
  return values;
}

async function saveOptions() {
  const status = document.getElementById('status');
  const setStatus = (message) => {
    status.textContent = message;
  };
  const domains = document.getElementById('domains')
    .value
    .split(',')
    .map(x => x.trim())
    .filter(x => !!x);
  let instanceUrl = document.getElementById('instanceUrl').value.trim();

  if (!instanceUrl) {
    setStatus('You must provide your Jira instance URL.');
    return;
  }
  if (!hasPathSlash.test(instanceUrl)) {
    instanceUrl = instanceUrl + '/';
  }
  if (instanceUrl.indexOf('://') === -1) {
    instanceUrl = 'https://' + instanceUrl;
  }
  document.getElementById('instanceUrl').value = instanceUrl;
  const permissionDomains = domains.concat([instanceUrl]);
  const currentInstanceUrl = await storageGet(defaultConfig);
  if (!currentInstanceUrl.instanceUrl) {
    domains.push(instanceUrl);
  }

  let granted;
  try {
    granted = await permissionsRequest({'origins': permissionDomains.map(toMatchUrl)});
  } catch (ex) {
    setStatus(ex.message);
    return;
  }

  if (granted) {
    await storageSet({
      instanceUrl,
      domains,
      v15upgrade: true,
      displayFields: getDisplayFieldValuesFromForm()
    });
    resetDeclarativeMapping();
    setStatus('Options saved.');
    setTimeout(function () {
      status.textContent = '';
    }, 2000);
  } else {
    setStatus('Options not saved.');
    return;
  }
  document.getElementById('domains').value = domains && domains.join(', ');
  document.getElementById('upgradeWarning').style.display = 'none';
}

async function main() {
  ReactDOM.render(
    ConfigPage(await storageGet(defaultConfig)), document.getElementById('container')
  );
}

function ConfigPage(props) {
  const displayFields = {
    ...defaultConfig.displayFields,
    ...(props.displayFields || {})
  };
  return (
    <div>
      {(() => {
        if (!props.v15upgrade) {
          return (
            <label id="upgradeWarning" className='upgradeWarning'>If you recently upgraded the extension make sure to
              click Save to activate
              the new reduced permissions !
              <br/><br/></label>);
        }
      })()}
      <label>
        Your full Jira instance url: <br/>
        <input
          id="instanceUrl"
          type="text"
          defaultValue={props.instanceUrl}
          placeholder="https://your-company.atlassian.net/"/>
      </label>
      <br/>
      <label>
        Locations where the plugin should be activated, comma separated: <br/>
        This can be a domain a url or any valid {' '}
        <strong><a href='https://developer.chrome.com/extensions/match_patterns'>match pattern</a>
        </strong>.
        <br/>
        <textarea id="domains" defaultValue={props.domains && props.domains.join(', ')} placeholder="1 site per line"/>
        <br/>
        You can also add new domains at any time by clicking on the extension icon !
      </label>
      <div id='status'></div>
      <br/>
      <label>
        Tooltip fields to show:
      </label>
      <div className='displayFields'>
        {FIELD_OPTIONS.map(({key, label}) => (
          <label key={key} className='displayFieldOption'>
            <input
              id={`displayField_${key}`}
              type='checkbox'
              defaultChecked={!!displayFields[key]}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
      <br/>
      <button onClick={saveOptions} id="save">Save</button>
    </div>
  );
}

document.addEventListener('DOMContentLoaded', main);

