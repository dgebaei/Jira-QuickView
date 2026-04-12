# Jira QuickView Privacy Policy

Effective date: 2026-04-12

This draft is based on the current implementation in this repository.

## Overview

Jira QuickView is a Chrome extension that detects Jira issue keys on pages you enable, shows Jira issue details in a hover popup, and lets you perform Jira actions without opening a separate Jira tab.

The extension does not operate a developer-run backend service. In the current implementation, it works inside your browser, stores its own settings in Chrome storage, and sends Jira requests directly from your browser to the Jira instance you configure.

## Information The Extension Handles

The extension may handle the following categories of data:

### 1. Extension configuration data

Jira QuickView stores extension settings in Chrome storage so the extension can keep working across browser sessions. This can include:

- Your configured Jira instance URL
- The pages or domains where you enabled the extension
- Popup layout and display preferences
- Custom field IDs and related configuration
- Theme, hover, and UI preference settings
- Team Sync source details such as a shared settings URL or Jira issue key and attachment filename
- Team Sync status and metadata such as last revision, sync timestamps, and the last applied shared settings payload

### 2. Page content on enabled pages

When Jira QuickView is enabled on a page, it scans page text locally in your browser to detect Jira issue keys such as `ABC-123`.

This page scanning is used to provide the core user-facing feature of the extension. The extension does not send full page contents to the developer.

By default, the extension can run on GitHub pages because pull requests, commits, issues, and review pages commonly contain Jira keys. You can also enable other sites yourself.

### 3. Jira data

When you configure a Jira instance and use the extension, Jira QuickView may request and display data from that Jira instance using your existing browser session. Depending on the feature you use, this can include:

- Issue metadata, status, priority, labels, sprint, versions, environment, and custom fields
- Issue descriptions and linked records
- Reporter, assignee, watchers, and related user display information
- Comments and reactions
- Attachments, thumbnails, and preview images
- Workflow transitions and edit options
- Worklog and time-tracking information

If you use editing features, the extension may also send updates you initiate to your Jira instance, such as:

- Field edits
- Comment creation, updates, and deletion
- Attachment uploads and deletion
- Workflow transitions
- Watcher changes
- Worklog updates

### 4. Authentication/session data

The extension uses your existing browser session with Jira. It does not ask you to create or store a separate Jira password inside the extension.

### 5. Shared settings file data

If you enable Settings Sync, Jira QuickView may request a shared JSON configuration file from:

- A Jira attachment on the Jira instance you configured
- A direct URL that you or your administrator configured in the extension

That shared JSON file can include organization-level Jira QuickView configuration such as layout settings, allowed page patterns, popup behavior, and Team Sync policy metadata.

## How Information Is Used

Jira QuickView uses the information above only to provide the extension’s user-facing functionality, including:

- Detecting Jira issue keys on pages you enable
- Fetching and showing Jira issue context in the popup
- Rendering avatars, attachments, and previews
- Saving your extension preferences
- Loading and applying shared Team Sync configuration when you enable Settings Sync
- Performing Jira actions that you explicitly trigger

## How Information Is Shared

Jira QuickView does not sell personal data.

Jira QuickView does not send your data to advertising networks, data brokers, or analytics services run by the developer.

Information is transmitted only as needed to:

- Your configured Jira instance, using your browser session, to provide the requested feature
- A user-configured or administrator-provided shared settings URL when you enable Settings Sync URL mode
- Services already involved in the page you choose to use, such as GitHub pages where Jira keys are detected locally in the page content

In the current implementation, pull request information shown in the popup is obtained from Jira issue data returned by Jira, not by separate GitHub API calls from the extension.

## Data Retention

- Extension settings remain in Chrome storage until you change them, clear browser storage, or remove the extension.
- Team Sync source details and last sync metadata remain in Chrome storage until you change them, disconnect Team Sync, clear browser storage, or remove the extension.
- Jira issue data, images, and popup state are primarily processed in memory during use and are not stored by the developer on a separate server.

## Your Choices

You can:

- Choose which pages or domains the extension is allowed to run on
- Change or remove the configured Jira instance URL
- Change or disconnect the Team Sync source at any time
- Remove the extension at any time
- Revoke site access and Chrome permissions through Chrome’s extension settings

## Security

Jira QuickView is designed to use the minimum data needed for its features. Requests to Jira are made from your browser to the Jira instance you configured. If you enable Settings Sync URL mode, the extension also requests the shared JSON settings file from the URL you configured. The extension does not use remote code in its current implementation.

You are responsible for configuring a valid Jira URL and for ensuring that your Jira instance is secured appropriately for your environment.

## Children’s Privacy

Jira QuickView is not directed to children.

## Changes To This Policy

This policy may be updated if the extension’s functionality or data handling changes. The effective date at the top of this page will be updated when changes are made.

## Contact

Publisher support URL: `https://github.com/dgebaei/Jira-QuickView/issues`

Publisher contact email: `dgebaei@gmail.com`
