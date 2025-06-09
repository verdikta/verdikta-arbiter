# Verdikta Arbiter Node Documentation

This directory contains the comprehensive installation and management documentation for the Verdikta Arbiter Node, built with MkDocs and the Material theme.

## Documentation Overview

The documentation is structured to guide users through the complete lifecycle of setting up and managing a Verdikta Arbiter Node:

- **Getting Started**: Overview, prerequisites, and quick start guide
- **Installation**: Detailed installation guides (automated and manual)
- **Management**: Service management, monitoring, and maintenance
- **Oracle Registration**: Blockchain integration and oracle registration
- **Troubleshooting**: Common issues and solutions
- **Reference**: Technical reference and API documentation

## Building the Documentation

### Prerequisites

- **Python 3.8 or higher** (required)
- **pip** (will be installed automatically if missing)
- **Internet connection** (for downloading dependencies)

### Installation

The documentation system includes an intelligent setup script that handles missing dependencies automatically.

#### Option 1: Automatic Setup (Recommended)

```bash
cd installer/docs
./serve.sh install
```

This will automatically:
- Check for Python 3 installation
- Install pip if not present (on Ubuntu/Debian, macOS with Homebrew, or using get-pip.py)
- Install all MkDocs dependencies
- Handle PATH configuration for user-installed packages

#### Option 2: Manual Setup

If you prefer manual control:

```bash
cd installer/docs

# Ensure pip is installed (if needed)
# Ubuntu/Debian: sudo apt-get install python3-pip
# macOS: brew install python3
# Other: curl https://bootstrap.pypa.io/get-pip.py | python3

# Install dependencies
pip3 install --user -r requirements.txt

# Add to PATH if needed (Linux/macOS)
export PATH="$HOME/.local/bin:$PATH"
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
```

### Verification

Verify the installation:

```bash
mkdocs --version
```

If mkdocs is not found, you may need to add `~/.local/bin` to your PATH:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Local Development

#### Serve Documentation Locally

Start the development server with live reload:

```bash
cd installer/docs
./serve.sh serve
```

The documentation will be available at [http://localhost:8000](http://localhost:8000)

#### Development Features

- **Live Reload**: Changes are automatically reflected in the browser
- **Search**: Full-text search functionality
- **Navigation**: Responsive navigation with section organization
- **Code Highlighting**: Syntax highlighting for all code blocks
- **Copy Buttons**: One-click copy for all code snippets

### Building for Production

#### Build Static Site

Generate the static HTML files:

```bash
cd installer/docs
./serve.sh build
```

This creates a `site/` directory with all static files ready for deployment.

#### Build Options

```bash
# Using the convenience script
./serve.sh build

# Or using mkdocs directly
mkdocs build --clean          # Clean build (removes previous build)
mkdocs build --strict         # Strict mode (treat warnings as errors)
mkdocs build --site-dir /path/to/output  # Custom output directory
```

## Deployment

### GitHub Pages

Deploy directly to GitHub Pages:

```bash
cd installer/docs
./serve.sh deploy
```

This builds the documentation and pushes it to the `gh-pages` branch.

### Manual Deployment

1. Build the documentation:
   ```bash
   ./serve.sh build
   ```

2. Upload the contents of the `site/` directory to your web server.

### Docker Deployment

Create a Docker container to serve the documentation:

```dockerfile
FROM nginx:alpine
COPY site/ /usr/share/nginx/html/
EXPOSE 80
```

Build and run:
```bash
./serve.sh build
docker build -t verdikta-docs .
docker run -p 80:80 verdikta-docs
```

## Convenience Script Usage

The `serve.sh` script provides several convenient commands:

```bash
# Install all dependencies (including pip if missing)
./serve.sh install

# Serve documentation locally with live reload
./serve.sh serve

# Build static documentation for production
./serve.sh build

# Deploy to GitHub Pages
./serve.sh deploy

# Show help and available commands
./serve.sh help
```

## Troubleshooting Installation

### Common Issues

#### Python Not Found

**Error**: `Python 3 is required but not installed`

**Solution**: Install Python 3.8 or higher:
- **Ubuntu/Debian**: `sudo apt-get install python3`
- **macOS**: `brew install python3` or download from [python.org](https://python.org)
- **Other systems**: Visit [python.org/downloads](https://python.org/downloads)

#### Pip Installation Fails

**Error**: Pip installation fails during automatic setup

**Solution**: Install pip manually:
```bash
# Download and run get-pip.py
curl https://bootstrap.pypa.io/get-pip.py -o get-pip.py
python3 get-pip.py --user
rm get-pip.py
```

#### MkDocs Not Found After Installation

**Error**: `mkdocs: command not found`

**Solution**: Add user packages to PATH:
```bash
export PATH="$HOME/.local/bin:$PATH"
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

#### Permission Denied

**Error**: Permission denied during installation

**Solution**: The script uses `--user` flag to avoid system-wide installation. If you still get permission errors:
```bash
# Use user installation explicitly
pip3 install --user -r requirements.txt
```

## Documentation Structure

```
docs/
├── mkdocs.yml                 # MkDocs configuration
├── requirements.txt           # Python dependencies
├── serve.sh                   # Convenience script with auto-setup
├── README.md                  # This build guide
├── index.md                   # Home page
├── overview.md                # System overview
├── prerequisites.md           # Prerequisites guide
├── quick-start.md             # Quick start guide
├── installation/              # Installation guides
│   ├── index.md
│   ├── automated.md
│   ├── manual.md
│   ├── environment.md
│   └── components/            # Component-specific guides
├── management/                # Service management
│   ├── index.md
│   ├── starting.md
│   ├── stopping.md
│   ├── status.md
│   └── logs.md
├── oracle/                    # Oracle registration
│   ├── index.md
│   ├── dispatcher.md
│   ├── queries.md
│   └── verification.md
├── maintenance/               # Maintenance guides
│   ├── index.md
│   ├── upgrading.md
│   ├── backup.md
│   └── configuration.md
├── troubleshooting/           # Troubleshooting
│   ├── index.md
│   ├── common-issues.md
│   ├── logs.md
│   └── support.md
└── reference/                 # Technical reference
    ├── index.md
    ├── scripts.md
    ├── configuration.md
    ├── api.md
    └── files.md
```

## Content Guidelines

### Writing Style

- **Clear and Concise**: Use simple, direct language
- **Action-Oriented**: Focus on what users need to do
- **Consistent Terminology**: Use the same terms throughout
- **Progressive Disclosure**: Start simple, add complexity gradually

### Code Examples

- **Complete Examples**: Provide full, runnable code snippets
- **Copy-Friendly**: Use the copy button feature for all code blocks
- **Syntax Highlighting**: Specify language for proper highlighting
- **Comments**: Add comments to explain complex code

### Formatting

- **Admonitions**: Use info, tip, warning, and danger boxes appropriately
- **Tables**: Use for structured data and comparisons
- **Lists**: Use bullet points for features, numbered lists for procedures
- **Links**: Use descriptive link text, not "click here"

### Images and Diagrams

- **Mermaid Diagrams**: Use for architecture and flow diagrams
- **Screenshots**: Provide visual guides for UI interactions
- **Alt Text**: Include descriptive alt text for accessibility

## Customization

### Theme Configuration

The Material theme is configured in `mkdocs.yml`:

```yaml
theme:
  name: material
  features:
    - content.code.copy
    - navigation.sections
    - navigation.tabs
    - search.highlight
  palette:
    - scheme: default
      primary: indigo
      accent: indigo
```

### Extensions

Key extensions enabled:

- **PyMdown Extensions**: Enhanced markdown features
- **Code Highlighting**: Syntax highlighting with Pygments
- **Mermaid**: Diagram support
- **Search**: Full-text search functionality

### Custom CSS

Add custom styles in `docs/stylesheets/extra.css` (if needed):

```yaml
extra_css:
  - stylesheets/extra.css
```

## Contributing

### Adding New Pages

1. Create a new markdown file in the appropriate directory
2. Add the page to the navigation in `mkdocs.yml`
3. Follow the established content guidelines
4. Test locally with `./serve.sh serve`

### Updating Existing Content

1. Make changes to the relevant markdown files
2. Test changes locally
3. Ensure all links and references are still valid
4. Update the last modified date if significant changes

### Review Process

- **Technical Accuracy**: Verify all commands and procedures
- **Link Validation**: Check that all internal and external links work
- **Consistency**: Ensure consistent formatting and terminology
- **Completeness**: Verify all prerequisites and steps are included

## Maintenance

### Regular Updates

- **Keep Dependencies Updated**: Regularly update `requirements.txt`
- **Review Content**: Ensure content stays current with software updates
- **Check Links**: Verify external links are still valid
- **Update Screenshots**: Refresh UI screenshots when interfaces change

### Performance

- **Image Optimization**: Compress images for faster loading
- **Build Time**: Monitor build performance and optimize as needed
- **Search Index**: The search index is automatically maintained

## Support

For documentation issues:

- **GitHub Issues**: Report problems or suggest improvements
- **Discord**: Get help from the community
- **Email**: Contact documentation team for major issues

## License

This documentation is part of the Verdikta Arbiter project and follows the same license terms as the main repository. 