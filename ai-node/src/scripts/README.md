# ClassID Integration Script

This script integrates the Verdikta ClassID Model Pool mapping functionality into your AI node, allowing you to automatically configure supported AI models based on curated ClassID specifications.

## Overview

The ClassID Integration Tool helps you:

1. **Discover Available Classes**: Lists all supported ClassID model pools with their associated AI models
2. **Interactive Selection**: Choose specific classes or select all available classes
3. **Automatic Configuration**: Updates your `models.ts` configuration with missing OpenAI and Anthropic models
4. **Ollama Integration**: Automatically pulls required Ollama models to your local system

## Usage

### Running the Script

```bash
# From the ai-node directory
npm run integrate-classid

# Or run directly
node src/scripts/classid-integration.js
```

### Interactive Process

1. **View Available Classes**: The script displays all available ClassID model pools:
   ```
   📋 Available ClassID Model Pools:
   ----------------------------------------
   
   1. ClassID 128: OpenAI & Anthropic Core
      Status: ✅ ACTIVE
      Models (3):
        openai: gpt-5, gpt-5-mini
        anthropic: claude-sonnet-4
      Limits: max_outcomes=20, max_panel_size=5
   
   2. ClassID 129: Open-Source Local (Ollama)
      Status: ✅ ACTIVE
      Models (4):
        ollama: llama3.1:8b, llava:7b, deepseek-r1:8b, qwen3:8b
      Limits: max_outcomes=20, max_panel_size=5
   ```

2. **Select Classes**: Choose your integration approach:
   - **Option 1**: Select specific classes by number (e.g., "1,3")
   - **Option 2**: Select all available classes

3. **Automatic Updates**: The script will:
   - Backup your current `models.ts` file
   - Add missing OpenAI and Anthropic models to the configuration
   - Determine model capabilities (image support, attachments) automatically

4. **Ollama Integration**: For Ollama models:
   - Option to automatically pull models using `ollama pull`
   - Manual instructions provided if you choose to skip

## Configuration Updates

### Before Integration
Your `models.ts` might look like:
```typescript
export const modelConfig = {
  openai: [
    { name: 'gpt-4', supportsImages: false, supportsAttachments: false },
    { name: 'gpt-4o', supportsImages: true, supportsAttachments: true },
  ],
  anthropic: [
    { name: 'claude-3-sonnet-20240229', supportsImages: true, supportsAttachments: true },
  ],
  ollama: [
    // Add ollama models here
  ],
};
```

### After Integration (Example with ClassID 128 & 129)
```typescript
export const modelConfig = {
  openai: [
    { name: 'gpt-4', supportsImages: false, supportsAttachments: false },
    { name: 'gpt-4o', supportsImages: true, supportsAttachments: true },
    { name: 'gpt-5', supportsImages: true, supportsAttachments: true },
    { name: 'gpt-5-mini', supportsImages: true, supportsAttachments: true },
  ],
  anthropic: [
    { name: 'claude-3-sonnet-20240229', supportsImages: true, supportsAttachments: true },
    { name: 'claude-sonnet-4', supportsImages: true, supportsAttachments: true },
  ],
  ollama: [
    { name: 'llama3.1:8b', supportsImages: false, supportsAttachments: true },
    { name: 'llava:7b', supportsImages: true, supportsAttachments: true },
    { name: 'deepseek-r1:8b', supportsImages: false, supportsAttachments: true },
    { name: 'qwen3:8b', supportsImages: false, supportsAttachments: true },
  ],
};
```

## Features

### Automatic Model Detection
The script automatically determines model capabilities:
- **Image Support**: Based on known model patterns (GPT-4, Claude-3, LLaVA, etc.)
- **Attachment Support**: Modern models generally support document attachments
- **Provider Classification**: Correctly categorizes models by their provider

### Safe Configuration Management
- **Backup Creation**: Original `models.ts` is backed up before changes
- **Incremental Updates**: Only adds missing models, preserves existing configuration
- **Error Recovery**: Detailed error messages and recovery instructions

### Ollama Integration
- **Automatic Pulling**: Uses `ollama pull` to download required models
- **Progress Display**: Shows download progress for large models
- **Error Handling**: Graceful handling of network issues or missing Ollama installation

## ClassID Model Pools

Based on the [Verdikta ClassID Usage Guide](https://docs.verdikta.com/verdikta-common/CLASSID_USAGE_GUIDE/), the current available classes are:

| ClassID | Name | Status | Providers | Models |
|---------|------|--------|-----------|---------|
| 128 | OpenAI & Anthropic Core | ACTIVE | openai, anthropic | gpt-5, gpt-5-mini, claude-sonnet-4 |
| 129 | Open-Source Local (Ollama) | ACTIVE | ollama | llama3.1:8b, llava:7b, deepseek-r1:8b, qwen3:8b |
| 130 | OSS via Hyperbolic API | EMPTY | (reserved) | (none) |

## Requirements

- **Node.js**: Version 16 or higher
- **@verdikta/common**: Version 1.1.1 or higher
- **Ollama** (optional): For local model integration

## Troubleshooting

### Common Issues

1. **"ClassID not found"**
   - Ensure `@verdikta/common` is version 1.1.1 or higher
   - Run `npm update @verdikta/common`

2. **"Failed to pull Ollama model"**
   - Check if Ollama is installed: `ollama --version`
   - Verify internet connection
   - Try pulling manually: `ollama pull <model-name>`

3. **"Permission denied writing models.ts"**
   - Check file permissions
   - Ensure the script has write access to the config directory

4. **"Backup file already exists"**
   - Previous backup exists at `models.ts.backup`
   - Remove or rename the backup file to proceed

### Debug Information

To get debug information about ClassID mappings:
```javascript
const { classMap } = require('@verdikta/common');

console.log('ClassID 128 tracked:', classMap.isTracked(128));
console.log('ClassID 128 reserved:', classMap.isReserved(128));

const cls = classMap.getClass(128);
if (cls) {
  console.log('Status:', cls.status);
  console.log('Models:', cls.models.length);
  console.log('Limits:', cls.limits);
}
```

## Next Steps

After running the integration:

1. **Verify Configuration**: Check that `models.ts` has been updated correctly
2. **Test Integration**: Start your AI node and verify new models are available
3. **Update Code**: Review any hardcoded model references in your application
4. **Monitor Performance**: Test the new models with your specific use cases

## Support

For issues related to:
- **ClassID mappings**: Refer to the [Verdikta ClassID Usage Guide](https://docs.verdikta.com/verdikta-common/CLASSID_USAGE_GUIDE/)
- **Integration script**: Check the troubleshooting section above
- **Model availability**: Verify with the respective AI providers (OpenAI, Anthropic, Ollama)

