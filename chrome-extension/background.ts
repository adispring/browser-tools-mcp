// background.ts - Chrome extension background script

export interface MessageResponse {
  success: boolean;
  url?: string;
  error?: string;
  path?: string;
  title?: string;
}

export interface UpdateServerUrlMessage {
  type: 'UPDATE_SERVER_URL';
  tabId: number;
  url: string;
  source?: string;
}

export interface GetCurrentUrlMessage {
  type: 'GET_CURRENT_URL';
  tabId: number;
}

export interface CaptureScreenshotMessage {
  type: 'CAPTURE_SCREENSHOT';
  tabId: number;
  format?: string;
  screenshotPath?: string;
}

export interface BrowserConnectorSettings {
  serverHost: string;
  serverPort: number;
}

export type Message =
  | UpdateServerUrlMessage
  | GetCurrentUrlMessage
  | CaptureScreenshotMessage;

// 维护标签页URL的缓存
const tabUrls = new Map<number, string>();

// Listen for messages from the devtools panel
chrome.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
  if (message.type === 'GET_CURRENT_URL' && message.tabId) {
    getCurrentTabUrl(message.tabId)
      .then((url) => {
        sendResponse({ success: true, url: url });
      })
      .catch((error: Error) => {
        sendResponse({ success: false, error: error.message });
      });
    return true; // Required to use sendResponse asynchronously
  }

  // Handle explicit request to update the server with the URL
  if (message.type === 'UPDATE_SERVER_URL' && message.tabId && message.url) {
    console.log(
      `Background: Received request to update server with URL for tab ${message.tabId}: ${message.url}`
    );
    updateServerWithUrl(
      message.tabId,
      message.url,
      message.source || 'explicit_update'
    )
      .then(() => {
        if (sendResponse) sendResponse({ success: true });
      })
      .catch((error: Error) => {
        console.error('Background: Error updating server with URL:', error);
        if (sendResponse)
          sendResponse({ success: false, error: error.message });
      });
    return true; // Required to use sendResponse asynchronously
  }

  if (message.type === 'CAPTURE_SCREENSHOT' && message.tabId) {
    // First get the server settings
    chrome.storage.local.get(['browserConnectorSettings'], (result) => {
      const settings: BrowserConnectorSettings =
        result.browserConnectorSettings || {
          serverHost: 'localhost',
          serverPort: 3025,
        };

      // Validate server identity first
      validateServerIdentity(settings.serverHost, settings.serverPort)
        .then((isValid) => {
          if (!isValid) {
            console.error(
              'Cannot capture screenshot: Not connected to a valid browser tools server'
            );
            sendResponse({
              success: false,
              error: 'Not connected to a valid browser tools server',
            });
            return;
          }

          // Proceed with screenshot
          captureAndSendScreenshot(message, settings, sendResponse);
        })
        .catch((error: Error) => {
          console.error('Error validating server identity:', error);
          sendResponse({
            success: false,
            error: `Server validation error: ${error.message}`,
          });
        });
    });
    return true; // Required to use sendResponse asynchronously
  }
});

export async function validateServerIdentity(
  host: string,
  port: number
): Promise<boolean> {
  try {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', `https://${host}:${port}/api/validate`, true);
      xhr.timeout = 5000;

      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const data = JSON.parse(xhr.responseText);
            if (!data.isValid || data.role !== 'browser-tools-server') {
              console.error(
                'Server validation failed: Invalid server identity',
                data
              );
              resolve(false);
            } else {
              resolve(true);
            }
          } catch (e) {
            console.error('Server validation error: Invalid response format');
            resolve(false);
          }
        } else {
          console.error(`Server validation failed with status: ${xhr.status}`);
          resolve(false);
        }
      };

      xhr.onerror = function () {
        console.error('Server validation error: Network error');
        resolve(false);
      };

      xhr.ontimeout = function () {
        console.error('Server validation error: Timeout');
        resolve(false);
      };

      xhr.send();
    });
  } catch (err) {
    console.error(
      'Server validation error:',
      err instanceof Error ? err.message : 'Unknown error'
    );
    return false;
  }
}

export function processTabForAudit(tab: chrome.tabs.Tab, tabId: number): void {
  if (tab && tab.url) {
    // Update the server with the current URL
    updateServerWithUrl(tabId, tab.url, 'tab_process_audit').catch((error) => {
      console.error('Error updating server with URL during audit:', error);
    });
  }
}

export async function getCurrentTabUrl(tabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (!tab || !tab.url) {
          reject(new Error('Unable to get current tab URL'));
          return;
        }

        resolve(tab.url);
      });
    } catch (error) {
      reject(error);
    }
  });
}

// Listen for tab updates to detect page refreshes and URL changes
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Track URL changes
  if (changeInfo.url) {
    console.log(`URL changed in tab ${tabId} to ${changeInfo.url}`);
    tabUrls.set(tabId, changeInfo.url);

    // Send URL update to server if possible
    updateServerWithUrl(tabId, changeInfo.url, 'tab_url_change');
  }

  // Check if this is a page refresh (status becoming "complete")
  if (changeInfo.status === 'complete') {
    // Update URL in our cache
    if (tab.url) {
      tabUrls.set(tabId, tab.url);
      // Send URL update to server if possible
      updateServerWithUrl(tabId, tab.url, 'page_complete');
    }

    retestConnectionOnRefresh(tabId);
  }
});

// Listen for tab activation (switching between tabs)
chrome.tabs.onActivated.addListener((activeInfo) => {
  const tabId = activeInfo.tabId;
  console.log(`Tab activated: ${tabId}`);

  // Get the URL of the newly activated tab
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError) {
      console.error('Error getting tab info:', chrome.runtime.lastError);
      return;
    }

    if (tab && tab.url) {
      console.log(`Active tab changed to ${tab.url}`);

      // Update our cache
      tabUrls.set(tabId, tab.url);

      // Send URL update to server
      updateServerWithUrl(tabId, tab.url, 'tab_activated');
    }
  });
});

export async function updateServerWithUrl(
  tabId: number,
  url: string,
  source: string = 'background_update'
): Promise<void> {
  if (!url) {
    console.error('Cannot update server with empty URL');
    return;
  }

  console.log(`Updating server with URL for tab ${tabId}: ${url}`);

  // Get the saved settings
  chrome.storage.local.get(['browserConnectorSettings'], async (result) => {
    const settings = result.browserConnectorSettings || {
      serverHost: 'localhost',
      serverPort: 3025,
    };

    // Maximum number of retry attempts
    const maxRetries = 3;
    let retryCount = 0;
    let success = false;

    while (retryCount < maxRetries && !success) {
      try {
        // Send the URL to the server
        const serverUrl = `https://${settings.serverHost}:${settings.serverPort}/current-url`;
        console.log(
          `Attempt ${retryCount + 1}/${maxRetries} to update server with URL: ${url}`
        );

        success = await new Promise<boolean>((resolve) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', serverUrl, true);
          xhr.setRequestHeader('Content-Type', 'application/json');
          xhr.timeout = 5000;

          xhr.onload = function () {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                const responseData = JSON.parse(xhr.responseText);
                console.log(
                  `Successfully updated server with URL: ${url}`,
                  responseData
                );
                resolve(true);
              } catch (e) {
                console.error('Error parsing server response');
                resolve(false);
              }
            } else {
              console.error(
                `Server returned error: ${xhr.status} ${xhr.statusText}`
              );
              resolve(false);
            }
          };

          xhr.onerror = function () {
            console.error('Network error when updating server with URL');
            resolve(false);
          };

          xhr.ontimeout = function () {
            console.error('Timeout when updating server with URL');
            resolve(false);
          };

          xhr.send(
            JSON.stringify({
              url: url,
              tabId: tabId,
              timestamp: Date.now(),
              source: source,
            })
          );
        });

        if (!success) {
          retryCount++;
          // Wait before retrying
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } catch (err) {
        console.error(
          `Error updating server with URL: ${err instanceof Error ? err.message : 'Unknown error'}`
        );
        retryCount++;
        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    if (!success) {
      console.error(
        `Failed to update server with URL after ${maxRetries} attempts`
      );
    }
  });
}

// Clean up when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  tabUrls.delete(tabId);
});

export async function retestConnectionOnRefresh(tabId: number): Promise<void> {
  console.log(`Page refreshed in tab ${tabId}, retesting connection...`);

  // Get the saved settings
  chrome.storage.local.get(['browserConnectorSettings'], async (result) => {
    const settings = result.browserConnectorSettings || {
      serverHost: 'localhost',
      serverPort: 3025,
    };

    // Test the connection with the last known host and port
    const isConnected = await validateServerIdentity(
      settings.serverHost,
      settings.serverPort
    );

    // Notify all devtools instances about the connection status
    chrome.runtime.sendMessage({
      type: 'CONNECTION_STATUS_UPDATE',
      isConnected: isConnected,
      tabId: tabId,
    });

    // Always notify for page refresh, whether connected or not
    // This ensures any ongoing discovery is cancelled and restarted
    chrome.runtime.sendMessage({
      type: 'INITIATE_AUTO_DISCOVERY',
      reason: 'page_refresh',
      tabId: tabId,
      forceRestart: true, // Add a flag to indicate this should force restart any ongoing processes
    });

    if (!isConnected) {
      console.log(
        'Connection test failed after page refresh, initiating auto-discovery...'
      );
    } else {
      console.log('Connection test successful after page refresh');
    }
  });
}

export function captureAndSendScreenshot(
  message: CaptureScreenshotMessage,
  settings: BrowserConnectorSettings,
  sendResponse: (response: MessageResponse) => void
): void {
  // Get the inspected window's tab
  chrome.tabs.get(message.tabId, (tab) => {
    if (chrome.runtime.lastError) {
      console.error('Error getting tab:', chrome.runtime.lastError);
      sendResponse({
        success: false,
        error: chrome.runtime.lastError.message,
      });
      return;
    }

    // Get all windows to find the one containing our tab
    chrome.windows.getAll({ populate: true }, (windows) => {
      const targetWindow = windows.find(
        (w) => w.tabs && w.tabs.some((t) => t.id === message.tabId)
      );

      if (!targetWindow) {
        console.error('Could not find window containing the inspected tab');
        sendResponse({
          success: false,
          error: 'Could not find window containing the inspected tab',
        });
        return;
      }

      // Capture screenshot of the window containing our tab
      if (targetWindow.id !== undefined) {
        chrome.tabs.captureVisibleTab(
          targetWindow.id,
          { format: 'png' },
          (dataUrl) => {
            // Ignore DevTools panel capture error if it occurs
            if (
              chrome.runtime.lastError &&
              chrome.runtime.lastError.message &&
              !chrome.runtime.lastError.message.includes('devtools://')
            ) {
              console.error(
                'Error capturing screenshot:',
                chrome.runtime.lastError
              );
              sendResponse({
                success: false,
                error: chrome.runtime.lastError.message,
              });
              return;
            }

            // Send screenshot data to browser connector using configured settings
            const serverUrl = `https://${settings.serverHost}:${settings.serverPort}/screenshot`;
            console.log(`Sending screenshot to ${serverUrl}`);

            // 使用 XMLHttpRequest 代替 Fetch API
            const xhr = new XMLHttpRequest();
            xhr.open('POST', serverUrl, true);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.timeout = 10000; // 更长的超时时间，因为截图可能很大

            xhr.onload = function () {
              if (xhr.status >= 200 && xhr.status < 300) {
                try {
                  const result = JSON.parse(xhr.responseText);
                  if (result.error) {
                    console.error('Error from server:', result.error);
                    sendResponse({ success: false, error: result.error });
                  } else {
                    console.log('Screenshot saved successfully:', result.path);
                    // Send success response even if DevTools capture failed
                    sendResponse({
                      success: true,
                      path: result.path,
                      title: tab.title || 'Current Tab',
                    });
                  }
                } catch (e) {
                  console.error('Error parsing server response');
                  sendResponse({
                    success: false,
                    error: 'Failed to parse server response',
                  });
                }
              } else {
                console.error(`Server returned error: ${xhr.status}`);
                sendResponse({
                  success: false,
                  error: `Failed to save screenshot: HTTP ${xhr.status}`,
                });
              }
            };

            xhr.onerror = function () {
              console.error('Error sending screenshot data: Network error');
              sendResponse({
                success: false,
                error: 'Network error when sending screenshot',
              });
            };

            xhr.ontimeout = function () {
              console.error('Error sending screenshot data: Timeout');
              sendResponse({
                success: false,
                error: 'Timeout when sending screenshot',
              });
            };

            xhr.send(
              JSON.stringify({
                data: dataUrl,
                path: message.screenshotPath,
              })
            );
          }
        );
      } else {
        console.error('Window ID is undefined');
        sendResponse({
          success: false,
          error: 'Window ID is undefined',
        });
      }
    });
  });
}
