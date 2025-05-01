import React, { useState, useRef } from 'react';

interface ImageUploadProps {
  onImageUpload: (file: File | null) => void;
  disabled?: boolean;
}

export const ImageUpload: React.FC<ImageUploadProps> = ({ onImageUpload, disabled = false }) => {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    setSelectedFile(file);
    onImageUpload(file);
  };

  const handleCancel = () => {
    setSelectedFile(null);
    onImageUpload(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className="mb-4">
      <label htmlFor="image-upload" className="block mb-2">Upload Image:</label>
      <input
        type="file"
        id="image-upload"
        accept="image/*"
        onChange={handleFileChange}
        className="mb-2"
        ref={fileInputRef}
        disabled={disabled}
      />
      {selectedFile && (
        <div className="flex items-center mt-2">
          <p className="mr-2">{selectedFile.name}</p>
          <button
            onClick={handleCancel}
            className="text-red-500 hover:text-red-700 focus:outline-none disabled:opacity-50"
            aria-label="Remove uploaded image"
            disabled={disabled}
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
};