// src/utils/fileUtils.ts

/**
 * Utility function to convert File to base64
 * @param {File} file - The file to convert
 * @returns {Promise<string>} - The base64 encoded string
 */
export async function fileToBase64(file: File): Promise<string> {
    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }