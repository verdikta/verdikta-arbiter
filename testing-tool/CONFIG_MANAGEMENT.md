# Configuration File Management Guide

This guide outlines best practices for managing configuration files in the Verdikta Testing Tool to prevent accidental overwrites and maintain version control integrity.

## Overview

The testing tool manages several types of configuration files:

### **Protected Files** (Safe from `npm start init`)
- `config/tool-config.json` - Only created if missing
- `config/juries/*.json` - Only created if no jury configs exist

### **Previously Unprotected Files** (Now Protected)
- `scenarios/scenarios.csv` - Your test scenarios
- `scenarios/attachments/*.zip` - Archive files with scenario data

## How `npm start init` Now Works

The init command has been updated with **safe defaults**:

1. **First Run**: Creates all example files as expected
2. **Subsequent Runs**: 
   - ✅ **Preserves existing** `scenarios.csv` and archive files
   - ✅ **Updates template** files (`.template` suffix)
   - ✅ **Shows clear messages** about what was preserved vs. created

## Best Practices

### 1. **Initial Setup**
```bash
cd testing-tool
npm start init  # Safe to run - creates examples
```

### 2. **Making Changes**
```bash
# Edit your actual configuration files
vim scenarios/scenarios.csv
vim config/juries/1.json

# Commit your changes
git add scenarios/scenarios.csv config/juries/
git commit -m "Update test scenarios and jury configurations"
```

### 3. **Getting Latest Templates**
```bash
# Re-run init to get updated templates (safe!)
npm start init

# Compare your files with new templates
diff scenarios/scenarios.csv scenarios/scenarios.csv.template
```

### 4. **Team Collaboration**
```bash
# Pull latest changes safely
git pull origin main

# If someone accidentally runs init, your committed files are safe
npm start init  # Won't overwrite committed configurations
```

## File-by-File Guide

### `scenarios/scenarios.csv`
- **Purpose**: Defines your test scenarios
- **Protection**: ✅ Protected from overwrite after first creation
- **Template**: `scenarios/scenarios.csv.template` (always updated)
- **Commit**: ✅ Yes - commit your customizations

### `scenarios/attachments/*.zip`
- **Purpose**: Archive files containing scenario data and attachments
- **Protection**: ✅ Protected from overwrite after first creation  
- **Commit**: ✅ Yes - commit your custom archives
- **Note**: Example archives are recreated only if missing

### `config/juries/*.json`
- **Purpose**: AI jury panel configurations
- **Protection**: ✅ Already protected (only created if none exist)
- **Commit**: ✅ Yes - these are your custom jury definitions
- **Naming**: 🔄 **Flexible** - filename can be anything (e.g., `high-stakes-panel.json`), ID comes from inside JSON

### `config/tool-config.json`
- **Purpose**: Tool settings (AI node URL, timeouts, etc.)
- **Protection**: ✅ Already protected (only created if missing)
- **Commit**: ✅ Yes - team settings should be shared

## Jury Configuration Naming

### **Flexible Naming (Recommended)**
You can now name jury files anything you want:
```bash
config/juries/
├── conservative-panel.json      # ID: 1
├── aggressive-trading.json      # ID: 128  
├── tech-innovation.json         # ID: 256
└── board-level-decisions.json   # ID: 500
```

### **Traditional Naming (Still Supported)**
The old numeric naming still works:
```bash
config/juries/
├── 1.json     # ID: 1
├── 128.json   # ID: 128
├── 256.json   # ID: 256
└── 500.json   # ID: 500
```

### **Important Notes**
- **ID comes from JSON content**, not filename
- Use descriptive names for better organization
- Duplicate IDs will be detected and warned about
- Invalid JSON files are automatically skipped

### **Example Configuration**
```json
{
  "id": 128,
  "name": "High-Stakes Strategic Panel",
  "models": [
    {
      "AI_PROVIDER": "OpenAI",
      "AI_MODEL": "gpt-4",
      "WEIGHT": 0.6,
      "NO_COUNTS": 1
    },
    {
      "AI_PROVIDER": "Anthropic",
      "AI_MODEL": "claude-3-sonnet-20240229",
      "WEIGHT": 0.4,
      "NO_COUNTS": 1
    }
  ],
  "iterations": 3
}
```

## Common Scenarios

### **New Team Member Setup**
```bash
git clone <repository>
cd testing-tool
npm install
npm start init        # Creates missing files, preserves existing
npm start status      # Verify setup
```

### **Updating Existing Installation**
```bash
git pull origin main
npm start init        # Safe - won't overwrite your configs
# Check for new templates and update your files as needed
```

### **Recovering from Accidental Overwrite**
```bash
# If someone accidentally overwrote files before this update:
git checkout HEAD -- scenarios/scenarios.csv
git checkout HEAD -- scenarios/attachments/
```

### **Starting Fresh** (Rare)
```bash
# If you want to reset to examples:
git rm scenarios/scenarios.csv scenarios/attachments/*.zip
npm start init        # Will recreate examples
```

## Migration from Old Behavior

If you have existing configurations before this protection was added:

1. **Verify your files are committed**:
   ```bash
   git status
   git add scenarios/ config/
   git commit -m "Preserve existing configurations"
   ```

2. **Test the new protection**:
   ```bash
   npm start init  # Should show "preserved existing file" messages
   ```

3. **Review new templates**:
   ```bash
   diff scenarios/scenarios.csv scenarios/scenarios.csv.template
   ```

## Development Workflow

### For Configuration Changes:
1. Edit the actual files (not templates)
2. Test your changes with `npm start test --dry-run`
3. Commit changes to git
4. Update documentation if needed

### For Template Updates:
1. Modify the code in `src/scenario-loader.js` or `src/attachment-handler.js`
2. Run `npm start init` to generate new templates
3. Compare templates with existing configs
4. Update the code and commit both code and template changes

## Error Prevention

### ✅ **Safe Operations**
- Running `npm start init` multiple times
- Pulling updates from git
- Editing configuration files directly
- Adding new scenarios or jury configs

### ⚠️ **Caution Required**
- Manually deleting configuration files
- Force-pushing changes that might affect others' configs
- Modifying the init command logic without testing

### ❌ **Avoid**
- Ignoring configuration files in `.gitignore`
- Using `npm start init` to "refresh" configurations (use templates instead)
- Sharing API keys or secrets in configuration files

## Troubleshooting

### "My changes disappeared!"
1. Check git status: `git status`
2. Look for your changes in git history: `git log --oneline`
3. If committed, restore: `git checkout HEAD~1 -- scenarios/scenarios.csv`

### "Init won't create missing files"
1. Verify file permissions: `ls -la scenarios/`
2. Check for hidden files: `ls -la scenarios/.scenarios.csv`
3. Try removing and recreating: `rm scenarios/scenarios.csv && npm start init`

### "Templates seem outdated"
1. Update your code: `git pull origin main`
2. Regenerate templates: `npm start init`
3. Check the generated date in template files

## Summary

✅ **Safe**: Your customized configuration files are now protected from accidental overwrites
📄 **Templates**: Always get the latest template files for reference  
🔄 **Reversible**: All changes are tracked in git for easy recovery
👥 **Team-friendly**: Multiple developers can safely run init without conflicts

For questions or issues, refer to the main README.md or contact the development team. 