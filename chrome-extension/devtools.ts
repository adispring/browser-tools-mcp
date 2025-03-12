// devtools.ts - Chrome extension devtools script

export interface Settings {
  logLimit: number;
  queryLimit: number;
  stringSizeLimit: number;
  maxLogSize: number;
  showRequestHeaders: boolean;
  showResponseHeaders: boolean;
  screenshotPath: string;
  serverHost: string;
  serverPort: number;
  allowAutoPaste: boolean;
}

export interface LogData {
  type: string;
  message: any;
  timestamp: number;
  source?: string;
  level?: string;
  requestBody?: string;
  responseBody?: string;
}

export interface ConnectionStatusMessage {
  type: 'CONNECTION_STATUS_UPDATE';
  isConnected: boolean;
}

export interface SettingsUpdatedMessage {
  type: 'SETTINGS_UPDATED';
  settings: Settings;
}

export type DevToolsMessage = ConnectionStatusMessage | SettingsUpdatedMessage;

// Store settings with defaults
const settings: Settings = {
  logLimit: 50,
  queryLimit: 30000,
  stringSizeLimit: 500,
  maxLogSize: 20000,
  showRequestHeaders: false,
  showResponseHeaders: false,
  screenshotPath: '', // Add new setting for screenshot path
  serverHost: 'localhost', // Default server host
  serverPort: 3025, // Default server port
  allowAutoPaste: false, // Default auto-paste setting
};

// Keep track of debugger state
let isDebuggerAttached = false;
let attachDebuggerRetries = 0;
const currentTabId = chrome.devtools.inspectedWindow.tabId;
const MAX_ATTACH_RETRIES = 3;
const ATTACH_RETRY_DELAY = 1000; // 1 second

// WebSocket instance
let ws: WebSocket | null = null;

// Load saved settings on startup
chrome.storage.local.get(['browserConnectorSettings'], (result) => {
  if (result.browserConnectorSettings) {
    Object.assign(settings, result.browserConnectorSettings);
  }
});

// Listen for settings updates
chrome.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
  if (message.type === 'SETTINGS_UPDATED') {
    const settingsMessage = message as SettingsUpdatedMessage;
    Object.assign(settings, settingsMessage.settings);

    // If server settings changed and we have a WebSocket, reconnect
    if (
      ws &&
      (settingsMessage.settings.serverHost !== settings.serverHost ||
        settingsMessage.settings.serverPort !== settings.serverPort)
    ) {
      console.log('Server settings changed, reconnecting WebSocket...');
      setupWebSocket();
    }
  }

  // Handle connection status updates from page refreshes
  if (message.type === 'CONNECTION_STATUS_UPDATE') {
    const statusMessage = message as ConnectionStatusMessage;
    console.log(
      `DevTools received connection status update: ${
        statusMessage.isConnected ? 'Connected' : 'Disconnected'
      }`
    );
  }
});

/**
 * Truncates strings in data object to prevent UI performance issues
 */
export function truncateStringsInData(
  data: any,
  maxLength: number,
  depth: number = 0,
  path: string = ''
): any {
  // Prevent infinite recursion
  if (depth > 10) {
    return '[Max Depth Exceeded]';
  }

  // Handle null or undefined
  if (data === null || data === undefined) {
    return data;
  }

  // Return primitives as-is
  if (typeof data !== 'object') {
    // If it's a string, truncate if needed
    if (typeof data === 'string' && data.length > maxLength) {
      return data.substring(0, maxLength) + '... (truncated)';
    }
    return data;
  }

  // Handle arrays
  if (Array.isArray(data)) {
    // If array is huge, truncate it
    if (data.length > 100) {
      return data
        .slice(0, 100)
        .map((item, index) =>
          truncateStringsInData(item, maxLength, depth + 1, `${path}[${index}]`)
        )
        .concat([`... (${data.length - 100} more items)`]);
    }

    return data.map((item, index) =>
      truncateStringsInData(item, maxLength, depth + 1, `${path}[${index}]`)
    );
  }

  // Handle objects
  const result: any = {};

  // Process only the first 100 keys for extremely large objects
  const keys = Object.keys(data);
  const processKeys = keys.length > 100 ? keys.slice(0, 100) : keys;

  for (const key of processKeys) {
    const newPath = path ? `${path}.${key}` : key;
    result[key] = truncateStringsInData(
      data[key],
      maxLength,
      depth + 1,
      newPath
    );
  }

  // Indicate truncation for large objects
  if (keys.length > 100) {
    result['__truncated'] = `${keys.length - 100} more properties not shown`;
  }

  return result;
}

/**
 * Calculate the size of an object in bytes (approximately)
 */
export function calculateObjectSize(obj: any): number {
  const objectList = new WeakSet();

  function sizeOf(value: any): number {
    if (value === null || value === undefined) {
      return 0;
    }

    // Handle primitive types
    if (typeof value === 'boolean') return 4;
    if (typeof value === 'number') return 8;
    if (typeof value === 'string') return value.length * 2;

    // Handle objects (but prevent cycles)
    if (typeof value === 'object') {
      if (objectList.has(value)) {
        return 0; // Already counted this object
      }

      let size = 0;
      objectList.add(value);

      // Arrays
      if (Array.isArray(value)) {
        size = 40; // Array overhead
        for (let i = 0; i < value.length; i++) {
          size += sizeOf(value[i]);
        }
        return size;
      }

      // Objects
      size = 40; // Object overhead
      for (const key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
          size += key.length * 2; // Key storage
          size += sizeOf(value[key]); // Value storage
        }
      }
      return size;
    }

    // Functions, symbols, etc.
    return 0;
  }

  return sizeOf(obj);
}

/**
 * Process an array with size limits to prevent performance issues
 */
export function processArrayWithSizeLimit(
  array: any[],
  maxTotalSize: number,
  processFunc: (item: any) => any
): any[] {
  if (!Array.isArray(array)) {
    console.error('Not an array:', array);
    return [];
  }

  // Return empty array for empty input
  if (array.length === 0) return [];

  // Process the first item to get a size estimate
  const firstProcessed = processFunc(array[0]);
  const firstItemSize = calculateObjectSize(firstProcessed);

  // Calculate roughly how many items we can include
  const estimatedItemsToInclude = Math.min(
    array.length,
    Math.floor(maxTotalSize / Math.max(1, firstItemSize))
  );

  // If we can include all items, process them all
  if (estimatedItemsToInclude >= array.length) {
    return array.map(processFunc);
  }

  // Otherwise, process a subset and indicate truncation
  const processed = array.slice(0, estimatedItemsToInclude).map(processFunc);

  // Add a message indicating truncation
  processed.push({
    __truncated: `${array.length - estimatedItemsToInclude} of ${array.length} items not shown due to size limits`,
  });

  return processed;
}

/**
 * Process a JSON string and limit its size
 */
export function processJsonString(
  jsonString: string,
  maxLength: number
): string {
  console.log('Processing string of length:', jsonString?.length);
  try {
    let parsed;
    try {
      parsed = JSON.parse(jsonString);
      console.log(
        'Successfully parsed as JSON, structure:',
        JSON.stringify(Object.keys(parsed))
      );
    } catch (e) {
      console.log('Not valid JSON, treating as string');
      return truncateStringsInData(jsonString, maxLength, 0, 'root');
    }

    // If it's an array, process with size limit
    if (Array.isArray(parsed)) {
      console.log('Processing array of objects with size limit');
      const processed = processArrayWithSizeLimit(
        parsed,
        settings.maxLogSize,
        (item) => truncateStringsInData(item, maxLength, 0, 'root')
      );
      const result = JSON.stringify(processed);
      console.log(
        `Processed array: ${parsed.length} -> ${processed.length} items`
      );
      return result;
    }

    // Otherwise process as before
    const processed = truncateStringsInData(parsed, maxLength, 0, 'root');
    const result = JSON.stringify(processed);
    console.log('Processed JSON string length:', result.length);
    return result;
  } catch (e) {
    console.error('Error in processJsonString:', e);
    return jsonString.substring(0, maxLength) + '... (truncated)';
  }
}

/**
 * Send data to the browser connector server
 */
export async function sendToBrowserConnector(logData: LogData): Promise<void> {
  if (!logData) {
    console.error('No log data provided to sendToBrowserConnector');
    return;
  }

  // First, ensure we're connecting to the right server
  if (!(await validateServerIdentity())) {
    console.error(
      'Cannot send logs: Not connected to a valid browser tools server'
    );
    return;
  }

  console.log('Sending log data to browser connector:', {
    type: logData.type,
    timestamp: logData.timestamp,
  });

  // Process any string fields that might contain JSON
  const processedData = { ...logData };

  if (logData.type === 'network-request') {
    console.log('Processing network request');
    if (processedData.requestBody) {
      console.log(
        'Request body size before:',
        processedData.requestBody.length
      );
      processedData.requestBody = processJsonString(
        processedData.requestBody,
        settings.stringSizeLimit
      );
      console.log('Request body size after:', processedData.requestBody.length);
    }
    if (processedData.responseBody) {
      console.log(
        'Response body size before:',
        processedData.responseBody.length
      );
      processedData.responseBody = processJsonString(
        processedData.responseBody,
        settings.stringSizeLimit
      );
      console.log(
        'Response body size after:',
        processedData.responseBody.length
      );
    }
  } else if (
    logData.type === 'console-log' ||
    logData.type === 'console-error'
  ) {
    console.log('Processing console message');
    if (processedData.message) {
      console.log('Message size before:', processedData.message.length);
      processedData.message = processJsonString(
        processedData.message,
        settings.stringSizeLimit
      );
      console.log('Message size after:', processedData.message.length);
    }
  }

  // Add settings to the request
  const payload = {
    data: {
      ...processedData,
      timestamp: Date.now(),
    },
    settings: {
      logLimit: settings.logLimit,
      queryLimit: settings.queryLimit,
      showRequestHeaders: settings.showRequestHeaders,
      showResponseHeaders: settings.showResponseHeaders,
    },
  };

  const finalPayloadSize = JSON.stringify(payload).length;
  console.log('Final payload size:', finalPayloadSize);

  if (finalPayloadSize > 1000000) {
    console.warn('Warning: Large payload detected:', finalPayloadSize);
    console.warn(
      'Payload preview:',
      JSON.stringify(payload).substring(0, 1000) + '...'
    );
  }

  const serverUrl = `https://${settings.serverHost}:${settings.serverPort}/extension-log`;
  console.log(`Sending log to ${serverUrl}`);

  try {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', serverUrl, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.timeout = 10000;

    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          console.log('Log sent successfully:', data);
        } catch (e) {
          console.error('Error parsing response:', e);
        }
      } else {
        console.error(`HTTP error ${xhr.status}`);
      }
    };

    xhr.onerror = function () {
      console.error('Error sending log: Network error');
    };

    xhr.ontimeout = function () {
      console.error('Error sending log: Timeout');
    };

    xhr.send(JSON.stringify(payload));
  } catch (error) {
    console.error('Error sending log:', error);
  }
}

/**
 * Validate server identity
 */
export async function validateServerIdentity(): Promise<boolean> {
  try {
    const serverUrl = `https://${settings.serverHost}:${settings.serverPort}/api/validate`;

    return new Promise<boolean>((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', serverUrl, true);
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.timeout = 3000;

      xhr.onload = function () {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const data = JSON.parse(xhr.responseText);

            // Check the response structure to validate server identity
            if (!data.isValid || data.role !== 'browser-tools-server') {
              console.error('Server validation failed: Invalid identity', data);
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
  } catch (error) {
    console.error('Server validation error:', error);
    return false;
  }
}

/**
 * Wipe logs from the console
 */
export function wipeLogs(): void {
  console.clear();
}

/**
 * Attach the debugger
 */
export async function attachDebugger(): Promise<void> {
  if (isDebuggerAttached) {
    console.log('Debugger already attached');
    return;
  }

  if (attachDebuggerRetries >= MAX_ATTACH_RETRIES) {
    console.error(
      `Maximum debugger attach retries (${MAX_ATTACH_RETRIES}) reached, giving up`
    );
    return;
  }

  try {
    await performAttach();
    console.log('Debugger attached successfully');
  } catch (error) {
    console.error('Error attaching debugger:', error);

    // Increment retry counter and try again after a delay
    attachDebuggerRetries++;
    setTimeout(() => {
      console.log(
        `Retrying debugger attachment (${attachDebuggerRetries}/${MAX_ATTACH_RETRIES})...`
      );
      attachDebugger();
    }, ATTACH_RETRY_DELAY);
  }
}

/**
 * Perform the actual debugger attachment
 */
export function performAttach(): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      chrome.debugger.attach({ tabId: currentTabId }, '1.3', () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        isDebuggerAttached = true;

        // Enable required debugger domains
        chrome.debugger.sendCommand(
          { tabId: currentTabId },
          'Network.enable',
          {},
          () => {
            if (chrome.runtime.lastError) {
              console.error(
                'Error enabling Network domain:',
                chrome.runtime.lastError
              );
            }
          }
        );

        chrome.debugger.sendCommand(
          { tabId: currentTabId },
          'Console.enable',
          {},
          () => {
            if (chrome.runtime.lastError) {
              console.error(
                'Error enabling Console domain:',
                chrome.runtime.lastError
              );
            }
          }
        );

        // Add event listeners
        chrome.debugger.onEvent.addListener(consoleMessageListener);

        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Detach the debugger
 */
export function detachDebugger(): void {
  if (!isDebuggerAttached) {
    console.log('Debugger not attached, nothing to detach');
    return;
  }

  try {
    chrome.debugger.detach({ tabId: currentTabId }, () => {
      if (chrome.runtime.lastError) {
        console.error('Error detaching debugger:', chrome.runtime.lastError);
        return;
      }

      isDebuggerAttached = false;
      attachDebuggerRetries = 0;
      console.log('Debugger detached successfully');

      // Remove event listeners
      chrome.debugger.onEvent.removeListener(consoleMessageListener);
    });
  } catch (error) {
    console.error('Error during debugger detachment:', error);
  }
}

/**
 * Listen for console messages
 */
export const consoleMessageListener = (
  source: chrome.debugger.Debuggee,
  method: string,
  params: any
) => {
  if (method === 'Console.messageAdded' && params && params.message) {
    const consoleMessage = params.message;

    // Create log data structure
    const logData: LogData = {
      type: consoleMessage.level === 'error' ? 'console-error' : 'console-log',
      message: consoleMessage.text,
      timestamp: Date.now(),
      source: 'debugger',
      level: consoleMessage.level,
    };

    // Send to browser connector
    sendToBrowserConnector(logData);
  }
};

/**
 * Capture and send the selected element
 */
export function captureAndSendElement(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    try {
      chrome.devtools.inspectedWindow.eval(
        `(function() { 
          try {
            const selectedElement = $0;
            if (!selectedElement) {
              return { error: 'No element selected' };
            }
            
            // Get basic information about the element
            const tagName = selectedElement.tagName.toLowerCase();
            const id = selectedElement.id;
            const classList = Array.from(selectedElement.classList);
            const attributes = {};
            
            for (let i = 0; i < selectedElement.attributes.length; i++) {
              const attr = selectedElement.attributes[i];
              attributes[attr.name] = attr.value;
            }
            
            // Get computed styles
            const computedStyle = window.getComputedStyle(selectedElement);
            const styles = {};
            
            for (let i = 0; i < computedStyle.length; i++) {
              const prop = computedStyle[i];
              styles[prop] = computedStyle.getPropertyValue(prop);
            }
            
            // Get accessibility properties
            const accessibility = {
              ariaLabel: selectedElement.getAttribute('aria-label'),
              ariaLabelledBy: selectedElement.getAttribute('aria-labelledby'),
              ariaDescribedBy: selectedElement.getAttribute('aria-describedby'),
              role: selectedElement.getAttribute('role'),
              tabIndex: selectedElement.tabIndex
            };
            
            // Get outer HTML (limited to prevent huge payloads)
            const outerHTML = selectedElement.outerHTML.substring(0, 10000);
            
            return {
              tagName,
              id,
              classList,
              attributes,
              styles,
              accessibility,
              outerHTML
            };
          } catch (error) {
            return { error: error.toString() };
          }
        })()`,
        (result, isException) => {
          if (isException) {
            console.error('Error capturing element:', isException);
            reject(new Error('Error capturing element: ' + isException));
            return;
          }

          const typedResult = result as Record<string, any>;

          if (typedResult && typedResult.error) {
            console.error('Error in element capture:', typedResult.error);
            reject(new Error(String(typedResult.error)));
            return;
          }

          // Send the element data to the server
          const logData: LogData = {
            type: 'selected-element',
            message: typedResult,
            timestamp: Date.now(),
            source: 'devtools',
          };

          sendToBrowserConnector(logData)
            .then(() => resolve())
            .catch((error) => reject(error));
        }
      );
    } catch (error) {
      console.error('Error in captureAndSendElement:', error);
      reject(error);
    }
  });
}

/**
 * Send a heartbeat to the server
 */
export function sendHeartbeat(): void {
  console.log('Sending heartbeat to server');

  // Get the current URL of the tab and send it to the server
  chrome.runtime.sendMessage(
    {
      type: 'GET_CURRENT_URL',
      tabId: currentTabId,
    },
    (response) => {
      if (chrome.runtime.lastError) {
        console.error('Error getting current URL:', chrome.runtime.lastError);
        return;
      }

      if (!response || !response.success) {
        console.error(
          'Failed to get current URL:',
          response?.error || 'Unknown error'
        );
        return;
      }

      // We have the URL, update the server
      chrome.runtime.sendMessage(
        {
          type: 'UPDATE_SERVER_URL',
          tabId: currentTabId,
          url: response.url,
          source: 'heartbeat',
        },
        (updateResponse) => {
          if (chrome.runtime.lastError) {
            console.error(
              'Error updating server with URL:',
              chrome.runtime.lastError
            );
          } else if (updateResponse && !updateResponse.success) {
            console.error(
              'Failed to update server with URL:',
              updateResponse.error
            );
          } else {
            console.log('Updated server with URL from heartbeat');
          }
        }
      );
    }
  );
}

/**
 * Set up the WebSocket connection
 */
export async function setupWebSocket(): Promise<void> {
  // Close existing connection if any
  if (ws) {
    console.log('Closing existing WebSocket connection');
    ws.close();
  }

  // Validate the server first
  if (!(await validateServerIdentity())) {
    console.error('Cannot set up WebSocket: Server identity validation failed');
    return;
  }

  const wsUrl = `wss://${settings.serverHost}:${settings.serverPort}/ws`;

  console.log(`Setting up WebSocket connection to ${wsUrl}`);

  try {
    const socket = new WebSocket(wsUrl);

    socket.onopen = (event) => {
      console.log('WebSocket connection established');

      // Send initial connection message
      socket.send(
        JSON.stringify({
          type: 'connect',
          tabId: currentTabId,
          timestamp: Date.now(),
        })
      );
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        console.log('WebSocket message received:', message);

        // Handle different message types
        if (message.type === 'ping') {
          // Respond to ping with pong
          socket.send(
            JSON.stringify({
              type: 'pong',
              timestamp: Date.now(),
            })
          );
        }
      } catch (error) {
        console.error('Error processing WebSocket message:', error);
      }
    };

    socket.onerror = (event) => {
      console.error('WebSocket error:', event);
    };

    socket.onclose = (event) => {
      console.log(
        `WebSocket connection closed: Code ${event.code} ${event.reason || '(no reason provided)'}`
      );

      // Attempt to reconnect after delay unless it was a clean close
      if (event.code !== 1000) {
        setTimeout(() => {
          console.log('Attempting to reconnect WebSocket...');
          setupWebSocket();
        }, 5000);
      }
    };

    // Store the socket reference
    ws = socket;
  } catch (error) {
    console.error('Error setting up WebSocket:', error);
  }
}

// Initialize the DevTools panel
chrome.devtools.panels.create('Browser Tools', '', 'panel.html', (panel) => {
  console.log('DevTools panel created');
});
