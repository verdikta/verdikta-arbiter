/**
 * Next.js Instrumentation
 * Used to suppress noisy development errors that don't affect functionality
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Suppress noisy "Failed to find Server Action" errors in development
    const originalConsoleError = console.error;
    console.error = (...args: any[]) => {
      // Filter out known harmless errors
      const message = args[0]?.toString() || '';
      
      // Suppress Server Action "x" errors (harmless Next.js dev mode artifact)
      if (message.includes('Failed to find Server Action "x"')) {
        return;
      }
      
      // Suppress "Cannot read properties of undefined (reading 'workers')" errors
      if (message.includes("Cannot read properties of undefined (reading 'workers')")) {
        return;
      }
      
      // Suppress "Cannot read properties of null (reading 'digest')" errors
      if (message.includes("Cannot read properties of null (reading 'digest')")) {
        return;
      }
      
      // Allow all other errors through
      originalConsoleError(...args);
    };
  }
}


