import React from 'react';

interface TabSelectorProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
}

export function TabSelector({ activeTab, onTabChange }: TabSelectorProps) {
  return (
    <div className="flex space-x-4 mb-6 border-b">
      <button
        className={`py-2 px-4 ${
          activeTab === 'generate'
            ? 'border-b-2 border-blue-500 text-blue-500'
            : 'text-gray-500'
        }`}
        onClick={() => onTabChange('generate')}
      >
        Generate
      </button>
      <button
        className={`py-2 px-4 ${
          activeTab === 'rank'
            ? 'border-b-2 border-blue-500 text-blue-500'
            : 'text-gray-500'
        }`}
        onClick={() => onTabChange('rank')}
      >
        Rank & Justify
      </button>
    </div>
  );
}
