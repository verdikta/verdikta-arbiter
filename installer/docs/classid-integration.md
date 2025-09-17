# ClassID Model Pool Integration

The Verdikta Arbiter installer now includes automatic integration with ClassID Model Pools from the `@verdikta/common` library. This ensures your AI Node is configured with the latest curated AI models for optimal arbitration performance.

## What is ClassID Integration?

ClassID Model Pools provide a curated mapping from ClassIDs to specific AI model configurations, enabling:

- **Deterministic validation** of Query Manifests with automatic truncation
- **Strict model pinning** to ensure reproducible results  
- **Resource limits** to prevent abuse and ensure fair usage
- **Provider abstraction** across OpenAI, Anthropic, Ollama, and other providers

## Integration During Installation

### Automatic Configuration

During the AI Node installation phase, the installer will:

1. **Install @verdikta/common** - The library containing ClassID mappings
2. **Discover Available Classes** - Find all active ClassID model pools
3. **Update models.ts** - Add missing models from ClassID pools to your configuration
4. **Configure Ollama Models** - Set up local models for pulling during Ollama installation
5. **Apply Capability Detection** - Automatically determine image and attachment support

### What Gets Configured

The installer automatically integrates models from all active ClassID pools:

| ClassID | Name | Models Added |
|---------|------|--------------|
| 128 | OpenAI & Anthropic Core | gpt-5, gpt-5-mini, claude-sonnet-4 |
| 129 | Open-Source Local (Ollama) | llama3.1:8b, llava:7b, deepseek-r1:8b, qwen3:8b |

### Model Capability Detection

The installer uses heuristic detection to configure model capabilities:

**Image Support:**
- OpenAI: gpt-4*, gpt-5*, o3*, gpt-4o
- Anthropic: claude-3*, claude-sonnet-4*, claude-4*
- Ollama: llava*, *vision*, minicpm*

**Attachment Support:**
- OpenAI: All models except gpt-3.5-turbo
- Anthropic: claude-3*, claude-sonnet-4*, claude-4*
- Ollama: All models (text attachments)

## Manual Configuration

### Interactive Configuration

After installation, you can reconfigure ClassID integration:

```bash
cd /path/to/your/installation/ai-node
npm run integrate-classid
```

This launches an interactive tool where you can:
- View all available ClassID model pools
- Select specific classes or all available classes
- Update your models.ts configuration
- Pull required Ollama models

### Testing Configuration

To verify your ClassID integration:

```bash
cd /path/to/your/installation/ai-node
npm run test-classid
```

This shows:
- Available ClassID model pools
- Current model configuration
- Model capability detection results
- Validation functionality testing

## Troubleshooting

### Common Issues

**"ClassID not found"**
- Ensure `@verdikta/common` is version 1.1.1 or higher
- Run `npm update @verdikta/common` in your ai-node directory

**"No active classes found"**
- Check your internet connection
- Verify the @verdikta/common package includes the classmap data

**"Models not updating"**
- Check file permissions on `src/config/models.ts`
- Look for backup files (`.backup` extension) if integration failed

### Debug Information

To check ClassID status manually:

```javascript
const { classMap } = require('@verdikta/common');

// Check available classes
console.log('Classes:', classMap.listClasses().length);

// Check specific class
const cls = classMap.getClass(128);
console.log('Class 128:', cls ? cls.name : 'Not found');
console.log('Models:', cls?.models?.length || 0);
```

## Benefits

### For Node Operators

- **Automatic Updates**: New models are available as ClassID pools are updated
- **Optimal Configuration**: Curated models ensure best arbitration performance
- **Resource Management**: Built-in limits prevent abuse and ensure fair usage
- **Provider Flexibility**: Support for multiple AI providers out of the box

### For Developers

- **Standardized Models**: Consistent model availability across all arbiters
- **Validation Support**: Automatic manifest validation and truncation
- **Capability Detection**: Reliable information about model capabilities
- **Easy Integration**: Simple npm scripts for configuration management

## Related Documentation

- [Verdikta ClassID Usage Guide](https://docs.verdikta.com/verdikta-common/CLASSID_USAGE_GUIDE/)
- [AI Node Configuration](ai-node-config.md)
- [Installation Guide](installation/automated.md)
- [Troubleshooting](troubleshooting/common-issues.md)

## Version Information

- **Introduced**: Installer v2.1.0
- **@verdikta/common**: Requires v1.1.1 or higher
- **ClassID Data Version**: Auto-detected from library

The ClassID integration ensures your Verdikta Arbiter is always configured with the latest curated AI models for optimal performance and compatibility.

