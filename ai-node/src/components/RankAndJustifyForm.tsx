import React, { useState } from 'react';
import { ModelWeight } from '../lib/types';
import { fileToBase64 } from '../lib/utils';
import { ModelSelector } from './ModelSelector';
import { AttachmentUpload } from './AttachmentUpload';

interface ProviderModel {
  name: string;
  supportsImages: boolean;
  supportsAttachments: boolean;
}

interface ProviderModels {
  provider: string;
  models: ProviderModel[];
}

interface RankAndJustifyFormProps {
  providerModels: ProviderModels[];
  isLoadingModels: boolean;
  onSubmit: (data: {
    prompt: string;
    models: ModelWeight[];
    attachments?: string[];
    iterations?: number;
    outcomes?: string[];
  }) => void;
}

export function RankAndJustifyForm({ providerModels, isLoadingModels, onSubmit }: RankAndJustifyFormProps) {
  const [prompt, setPrompt] = useState('');
  const [selectedModels, setSelectedModels] = useState<ModelWeight[]>([]);
  const [iterations, setIterations] = useState(1);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [outcomes, setOutcomes] = useState<string[]>([]);
  const [newOutcome, setNewOutcome] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleAddModel = () => {
    if (providerModels.length > 0) {
      const firstProvider = providerModels[0];
      const firstModel = firstProvider.models[0];
      setSelectedModels([
        ...selectedModels,
        {
          provider: firstProvider.provider,
          model: firstModel.name,
          weight: 1,
          count: 1
        }
      ]);
    }
  };

  const handleModelChange = (index: number, field: keyof ModelWeight, value: string | number) => {
    const updatedModels = [...selectedModels];
    
    // When changing provider, reset the model to the first model of the new provider
    if (field === 'provider') {
      const newProvider = providerModels.find(pm => pm.provider === value);
      if (newProvider && newProvider.models.length > 0) {
        updatedModels[index] = { 
          ...updatedModels[index], 
          provider: value as string,
          model: newProvider.models[0].name  // Reset to first model of new provider
        };
      } else {
        updatedModels[index] = { ...updatedModels[index], [field]: value };
      }
    } else {
      updatedModels[index] = { ...updatedModels[index], [field]: value };
    }
    
    setSelectedModels(updatedModels);
  };

  const handleRemoveModel = (index: number) => {
    setSelectedModels(selectedModels.filter((_, i) => i !== index));
  };

  const handleAddOutcome = () => {
    if (newOutcome.trim()) {
      setOutcomes([...outcomes, newOutcome.trim()]);
      setNewOutcome('');
    }
  };

  const handleRemoveOutcome = (index: number) => {
    setOutcomes(outcomes.filter((_, i) => i !== index));
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleAddOutcome();
    }
  };

  const validateForm = (): boolean => {
    if (outcomes.length < 2) {
      setValidationError('Please add at least two possible outcomes');
      return false;
    }
    setValidationError(null);
    return true;
  };

  const resetForm = () => {
    setPrompt('');
    setSelectedModels([]);
    setIterations(1);
    setAttachments([]);
    setOutcomes([]);
    setNewOutcome('');
    setValidationError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validateForm()) {
      return;
    }

    setIsAnalyzing(true);
    try {
      // Convert files to base64
      const attachmentPromises = attachments.map(fileToBase64);
      const attachmentsBase64 = await Promise.all(attachmentPromises);

      await onSubmit({
        prompt,
        models: selectedModels,
        attachments: attachmentsBase64,
        iterations,
        outcomes: outcomes.length > 0 ? outcomes : undefined
      });

      // Don't reset the form - remove the resetForm() call
      // Just clear any validation errors
      setValidationError(null);
    } catch (error) {
      console.error('Error during analysis:', error);
      setValidationError('An error occurred during analysis. Please try again.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setAttachments(Array.from(e.target.files));
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div>
        <label htmlFor="prompt" className="block text-sm font-medium mb-2">
          Scenario Description:
        </label>
        <textarea
          id="prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className="w-full p-2 border rounded text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-800"
          rows={4}
          required
          disabled={isAnalyzing}
        />
      </div>

      <div>
        <label className="block text-sm font-medium mb-2">
          Possible Outcomes:
          <span className="text-sm text-gray-600 dark:text-gray-400 ml-2">
            (minimum 2 required)
          </span>
        </label>
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              type="text"
              value={newOutcome}
              onChange={(e) => setNewOutcome(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="Enter an outcome"
              className="flex-1 p-2 border rounded text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-800"
              disabled={isAnalyzing}
            />
            <button
              type="button"
              onClick={handleAddOutcome}
              className="bg-green-500 text-white px-4 py-2 rounded disabled:opacity-50"
              disabled={!newOutcome.trim() || isAnalyzing}
            >
              Add
            </button>
          </div>
          {outcomes.length > 0 && (
            <div className="mt-2 space-y-2">
              {outcomes.map((outcome, index) => (
                <div key={index} className="flex items-center gap-2 bg-gray-100 dark:bg-gray-700 p-2 rounded">
                  <span className="flex-1">{outcome}</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveOutcome(index)}
                    className="text-red-500 hover:text-red-700 disabled:opacity-50"
                    disabled={isAnalyzing}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
          {outcomes.length > 0 && (
            <p className="text-sm text-gray-600 dark:text-gray-400">
              The model will evaluate the likelihood of each outcome, ensuring scores sum to 1,000,000
            </p>
          )}
        </div>
      </div>

      {validationError && (
        <div className="text-red-500 text-sm p-2 bg-red-100 dark:bg-red-900 rounded">
          {validationError}
        </div>
      )}

      <div>
        <label className="block text-sm font-medium mb-2">Models:</label>
        {selectedModels.map((model, index) => (
          <div key={index} className="flex gap-4 mb-4 items-center">
            <div>
              <label className="block text-xs mb-1">Provider</label>
              <select
                value={model.provider}
                onChange={(e) => handleModelChange(index, 'provider', e.target.value)}
                className="p-2 border rounded text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-800"
                disabled={isAnalyzing}
              >
                {providerModels.map((pm) => (
                  <option key={pm.provider} value={pm.provider}>
                    {pm.provider}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs mb-1">Model</label>
              <select
                value={model.model}
                onChange={(e) => handleModelChange(index, 'model', e.target.value)}
                className="p-2 border rounded text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-800"
                disabled={isAnalyzing}
              >
                {providerModels.find(pm => pm.provider === model.provider)?.models.map(m => (
                  <option key={m.name} value={m.name}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs mb-1">Weight</label>
              <input
                type="number"
                value={model.weight}
                onChange={(e) => handleModelChange(index, 'weight', parseFloat(e.target.value))}
                step="0.1"
                min="0"
                max="1"
                className="p-2 border rounded w-24 text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-800"
                disabled={isAnalyzing}
              />
            </div>

            <div>
              <label className="block text-xs mb-1">Count</label>
              <input
                type="number"
                value={model.count || 1}
                onChange={(e) => {
                  const value = parseInt(e.target.value);
                  if (value >= 1 && Number.isInteger(value)) {
                    handleModelChange(index, 'count', value);
                  }
                }}
                min="1"
                step="1"
                className="p-2 border rounded w-24 text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-800"
                placeholder="Count"
                disabled={isAnalyzing}
              />
            </div>

            <div className="flex items-end">
              <button
                type="button"
                onClick={() => handleRemoveModel(index)}
                className="p-2 text-red-500 hover:text-red-700 disabled:opacity-50"
                disabled={isAnalyzing}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
        <button
          type="button"
          onClick={handleAddModel}
          className="bg-green-500 text-white px-4 py-2 rounded disabled:opacity-50"
          disabled={isAnalyzing}
        >
          Add Model
        </button>
      </div>

      <div>
        <label htmlFor="iterations" className="block text-sm font-medium mb-2">
          Iterations:
        </label>
        <input
          type="number"
          id="iterations"
          value={iterations}
          onChange={(e) => setIterations(parseInt(e.target.value))}
          min="1"
          className="p-2 border rounded text-gray-900 dark:text-gray-100 bg-white dark:bg-gray-800"
          disabled={isAnalyzing}
        />
      </div>

      <div className="space-y-4">
        <div className="flex flex-col space-y-2">
          <label className="text-sm font-medium">Attachments:</label>
          <AttachmentUpload onFileUpload={handleFileChange} disabled={isAnalyzing} />
          {attachments.length > 0 && (
            <p className="mt-2 text-sm text-green-600">
              {attachments.length} file(s) uploaded successfully
            </p>
          )}
        </div>
      </div>

      <div className="flex gap-4">
        <button
          type="submit"
          className="bg-blue-500 text-white px-4 py-2 rounded disabled:opacity-50"
          disabled={isLoadingModels || selectedModels.length === 0 || isAnalyzing}
        >
          {isAnalyzing ? 'Analyzing...' : 'Analyze'}
        </button>

        <button
          type="button"
          onClick={resetForm}
          className="bg-gray-500 text-white px-4 py-2 rounded disabled:opacity-50"
          disabled={isAnalyzing}
        >
          Reset Form
        </button>
      </div>
    </form>
  );
} 