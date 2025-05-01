import React from 'react';

interface ModelSelectorProps {
  models: Array<{ name: string; supportsImages: boolean; supportsAttachments: boolean }>;
  selectedModel: string;
  onModelChange: (model: string) => void;
  className?: string;
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({ models, selectedModel, onModelChange, className }) => {
  return (
    <select
      id="model"
      value={selectedModel}
      onChange={(e) => onModelChange(e.target.value)}
      className={`w-full p-2 border rounded text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-800 ${className}`}
    >
      {models.map((model) => (
        <option key={model.name} value={model.name}>
          {model.name}
          {model.supportsImages && model.supportsAttachments ? ' (Supports Attachments)' : 
           model.supportsImages ? ' (Images Only)' : 
           model.supportsAttachments ? ' (Attachments)' : ''}
        </option>
      ))}
    </select>
  );
};