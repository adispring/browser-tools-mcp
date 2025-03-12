// panel.ts - Chrome extension panel script

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

export interface ConnectionStatusUpdateMessage {
  type: 'CONNECTION_STATUS_UPDATE';
  isConnected: boolean;
}

export type PanelMessage = ConnectionStatusUpdateMessage;

// Store settings
const settings: Settings = {
  logLimit: 50,
  queryLimit: 30000,
  stringSizeLimit: 500,
  showRequestHeaders: false,
  showResponseHeaders: false,
  maxLogSize: 20000,
  screenshotPath: '',
  // Add server connection settings
  serverHost: 'localhost',
  serverPort: 3025,
  allowAutoPaste: false, // Default auto-paste setting
};

// Track connection status
let serverConnected = false;
const reconnectAttemptTimeout: number | null = null;
// Add a flag to track ongoing discovery operations
const isDiscoveryInProgress = false;
// Add an AbortController to cancel fetch operations
const discoveryController: AbortController | null = null;

// Load saved settings on startup
chrome.storage.local.get(['browserConnectorSettings'], (result) => {
  if (result.browserConnectorSettings) {
    Object.assign(settings, result.browserConnectorSettings);
    updateUIFromSettings();
  }

  // Create connection status banner at the top
  createConnectionBanner();

  // Automatically discover server on panel load with quiet mode enabled
  discoverServer(true);
});

// Add listener for connection status updates from background script (page refresh events)
chrome.runtime.onMessage.addListener((message: any, sender, sendResponse) => {
  if (message.type === 'CONNECTION_STATUS_UPDATE') {
    const statusMessage = message as ConnectionStatusUpdateMessage;
    console.log(
      `Received connection status update: ${
        statusMessage.isConnected ? 'Connected' : 'Disconnected'
      }`
    );

    // Update UI based on connection status
    if (statusMessage.isConnected) {
      // If already connected, just maintain the current state
      if (!serverConnected) {
        // Update connection state
        serverConnected = true;
        // Update UI
        updateConnectionBanner(true, {
          host: settings.serverHost,
          port: settings.serverPort,
        });
      }
    } else {
      // If disconnected, update UI
      serverConnected = false;
      updateConnectionBanner(false);
      // Schedule a reconnection attempt
      scheduleReconnectAttempt();
    }
  }
});

/**
 * Creates the connection status banner
 */
export function createConnectionBanner(): void {
  // Check if the banner already exists
  if (document.getElementById('connection-banner')) {
    return;
  }

  // Create the banner container
  const banner = document.createElement('div');
  banner.id = 'connection-banner';
  banner.style.cssText = `
    display: flex;
    align-items: center;
    width: 100%;
    padding: 4px 8px;
    background-color: #333333;
    color: white;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 11px;
    box-sizing: border-box;
    height: 24px;
    position: relative;
    z-index: 1000;
    box-shadow: 0 1px 3px rgba(0,0,0,0.12);
  `;

  // Create reconnect button
  const reconnectButton = document.createElement('button');
  reconnectButton.id = 'banner-reconnect-btn';
  reconnectButton.textContent = 'Reconnect';
  reconnectButton.style.cssText = `
    background-color: #333333;
    color: white;
    border: none;
    padding: 2px 6px;
    font-size: 10px;
    cursor: pointer;
    border-radius: 3px;
    margin-right: 8px;
    display: none; // Initially hidden
    transition: background-color 0.2s ease;
  `;

  // Add hover effects
  reconnectButton.addEventListener('mouseover', () => {
    reconnectButton.style.backgroundColor = '#444444';
  });
  reconnectButton.addEventListener('mouseout', () => {
    reconnectButton.style.backgroundColor = '#333333';
  });
  reconnectButton.addEventListener('click', () => {
    // Hide the button while reconnecting
    reconnectButton.style.display = 'none';
    reconnectButton.textContent = 'Reconnecting...';

    // Update UI to show searching state
    updateConnectionBanner(false, null);

    // Try to discover server
    discoverServer(false);
  });

  // Create a container for the status indicator and text
  const statusContainer = document.createElement('div');
  statusContainer.style.cssText = `
    display: flex;
    align-items: center;
    width: 100%;
  `;

  // Create status indicator
  const indicator = document.createElement('div');
  indicator.id = 'banner-status-indicator';
  indicator.style.cssText = `
    width: 6px; 
    height: 6px; 
    position: relative;
    top: 1px;
    border-radius: 50%; 
    background-color: #ccc; 
    margin-right: 8px; 
    flex-shrink: 0;
    transition: background-color 0.3s ease;
  `;

  // Create status text
  const statusText = document.createElement('div');
  statusText.id = 'banner-status-text';
  statusText.textContent = 'Searching for server...';
  statusText.style.cssText =
    'flex-grow: 1; font-weight: 400; letter-spacing: 0.1px; font-size: 11px;';

  // Add elements to statusContainer
  statusContainer.appendChild(indicator);
  statusContainer.appendChild(statusText);

  // Add elements to banner - reconnect button first, then status container
  banner.appendChild(reconnectButton);
  banner.appendChild(statusContainer);

  // Add banner to the beginning of the document body
  // This ensures it's the very first element
  document.body.prepend(banner);

  // Set initial state
  updateConnectionBanner(false, null);
}

/**
 * Updates the connection banner based on connection status
 */
export function updateConnectionBanner(
  connected: boolean,
  serverInfo?: { host: string; port: number } | null
): void {
  const indicator = document.getElementById('banner-status-indicator');
  const statusText = document.getElementById('banner-status-text');
  const banner = document.getElementById('connection-banner');
  const reconnectButton = document.getElementById('banner-reconnect-btn');

  if (!indicator || !statusText || !banner || !reconnectButton) return;

  if (connected && serverInfo) {
    // Connected state with server info
    indicator.style.backgroundColor = '#4CAF50'; // Green indicator
    statusText.style.color = '#ffffff'; // White text for contrast on black
    statusText.textContent = `Connected to browser tools server at ${serverInfo.host}:${serverInfo.port}`;

    // Hide reconnect button when connected
    reconnectButton.style.display = 'none';
  } else if (connected) {
    // Connected without server info
    indicator.style.backgroundColor = '#4CAF50'; // Green indicator
    statusText.style.color = '#ffffff'; // White text for contrast on black
    statusText.textContent = `Connected to server at ${settings.serverHost}:${settings.serverPort}`;

    // Hide reconnect button when connected
    reconnectButton.style.display = 'none';
  } else {
    // Disconnected state
    indicator.style.backgroundColor = '#F44336'; // Red indicator
    statusText.style.color = '#ffffff'; // White text for contrast on black

    // Only show "searching" message if discovery is in progress
    if (isDiscoveryInProgress) {
      statusText.textContent = 'Not connected to server. Searching...';
      // Hide reconnect button while actively searching
      reconnectButton.style.display = 'none';
    } else {
      statusText.textContent = 'Not connected to server.';
      // Show reconnect button above status message when disconnected and not searching
      reconnectButton.style.display = 'block';
      reconnectButton.textContent = 'Reconnect';
    }
  }
}

/**
 * Updates UI elements based on current settings
 */
export function updateUIFromSettings(): void {
  // This would update UI elements based on the settings
  // Since we don't have direct access to the DOM elements here,
  // this function would typically update form elements or UI components
  // with values from the settings object
  console.log('Updating UI from settings:', settings);
}

/**
 * Saves current settings to chrome storage
 */
export function saveSettings(): void {
  // Save the current settings to Chrome storage
  chrome.storage.local.set(
    {
      browserConnectorSettings: settings,
    },
    () => {
      if (chrome.runtime.lastError) {
        console.error('Error saving settings:', chrome.runtime.lastError);
      } else {
        console.log('Settings saved successfully');

        // Notify other extension components about the settings update
        chrome.runtime.sendMessage({
          type: 'SETTINGS_UPDATED',
          settings: settings,
        });
      }
    }
  );
}

/**
 * Cancels any ongoing discovery operation
 */
export function cancelOngoingDiscovery(): void {
  if (discoveryController) {
    console.log('Cancelling ongoing discovery operation');
    discoveryController.abort();
    // discoveryController = null;
  }

  if (reconnectAttemptTimeout) {
    console.log('Clearing reconnection timeout');
    clearTimeout(reconnectAttemptTimeout);
    // reconnectAttemptTimeout = null;
  }
}

/**
 * Tests connection to the specified server
 */
export async function testConnection(
  host: string,
  port: number
): Promise<boolean> {
  console.log(`Testing connection to server at ${host}:${port}`);

  try {
    // Update UI to show testing state
    if (host === settings.serverHost && port === settings.serverPort) {
      updateConnectionBanner(false);
      const statusText = document.getElementById('banner-status-text');
      if (statusText) {
        statusText.textContent = 'Testing connection...';
      }
    }

    // Test the connection
    const url = `https://${host}:${port}/api/validate`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    // 使用 XMLHttpRequest 代替 Fetch API 以提高兼容性
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.timeout = 5000;

      xhr.onload = function () {
        clearTimeout(timeoutId);
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const data = JSON.parse(xhr.responseText);
            if (!data.isValid || data.role !== 'browser-tools-server') {
              console.error('Server validation failed:', data);
              resolve(false);
            } else {
              console.log('Connection test successful', data);
              resolve(true);
            }
          } catch (error) {
            console.error('Error parsing server response:', error);
            resolve(false);
          }
        } else {
          console.error(`Server test failed with status: ${xhr.status}`);
          resolve(false);
        }
      };

      xhr.onerror = function () {
        clearTimeout(timeoutId);
        console.error('Error testing connection: Network error');
        resolve(false);
      };

      xhr.ontimeout = function () {
        console.error('Connection test timed out');
        resolve(false);
      };

      xhr.send();
    });
  } catch (error) {
    console.error('Error testing connection:', error);
    return false;
  }
}

/**
 * Schedules a reconnection attempt after a delay
 */
export function scheduleReconnectAttempt(): void {
  // Cancel any existing reconnection attempts
  if (reconnectAttemptTimeout) {
    clearTimeout(reconnectAttemptTimeout);
    // reconnectAttemptTimeout = null;
  }

  // Schedule a new reconnection attempt
  /* reconnectAttemptTimeout = */ setTimeout(() => {
    console.log('Attempting to reconnect to server');
    discoverServer(true);
  }, 5000) as unknown as number; // 5 second delay
}

/**
 * Tries to connect to the specified server
 */
export async function tryServerConnection(
  host: string,
  port: number
): Promise<boolean> {
  console.log(`Trying connection to ${host}:${port}`);

  // First test if the server is available
  const isAvailable = await testConnection(host, port);

  if (!isAvailable) {
    console.log(`Server at ${host}:${port} is not available`);
    return false;
  }

  // Update settings with the new server details
  settings.serverHost = host;
  settings.serverPort = port;

  // Save settings
  saveSettings();

  // Update connection banner
  serverConnected = true;
  updateConnectionBanner(true, { host, port });

  console.log(`Successfully connected to server at ${host}:${port}`);
  return true;
}

/**
 * Discovers available browser connector servers
 */
export async function discoverServer(
  quietMode: boolean = false
): Promise<void> {
  // Cancel any ongoing discovery operations
  cancelOngoingDiscovery();

  // Set flag to indicate discovery is in progress
  // isDiscoveryInProgress = true;

  // Update UI if not in quiet mode
  if (!quietMode) {
    updateConnectionBanner(false);
    const statusText = document.getElementById('banner-status-text');
    if (statusText) {
      statusText.textContent = 'Searching for browser tools server...';
    }
  }

  // Create an AbortController for this operation
  const controller = new AbortController();
  // discoveryController = controller;

  try {
    // First try the currently configured server
    if (settings.serverHost && settings.serverPort) {
      console.log(
        `Trying configured server at ${settings.serverHost}:${settings.serverPort}`
      );
      const isConnected = await tryServerConnection(
        settings.serverHost,
        settings.serverPort
      );

      if (isConnected) {
        console.log('Connected to configured server');
        return;
      }
    }

    // If that fails, try localhost on common ports
    const commonPorts = [3025, 3000, 8080, 8000];

    for (const port of commonPorts) {
      // Check if discovery was cancelled
      if (controller.signal.aborted) {
        console.log('Discovery cancelled');
        return;
      }

      console.log(`Trying localhost:${port}`);
      const isConnected = await tryServerConnection('localhost', port);

      if (isConnected) {
        console.log(`Connected to server at localhost:${port}`);
        return;
      }
    }

    // If we get here, we couldn't find a server
    console.log('No browser tools server found');

    // Update UI
    updateConnectionBanner(false);
  } catch (error) {
    console.error('Error during server discovery:', error);
  } finally {
    // Reset flag
    // isDiscoveryInProgress = false;

    // Update UI if discovery was not successful
    if (!serverConnected) {
      updateConnectionBanner(false);
    }
  }
}
