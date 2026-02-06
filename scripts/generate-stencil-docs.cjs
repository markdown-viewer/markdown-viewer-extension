const fs = require('fs');
const path = require('path');

// Read the stencil-names.json
const stencilData = JSON.parse(fs.readFileSync(path.join(__dirname, '../temp/stencil-names.json'), 'utf8'));

const names = stencilData.names;
const specialStyles = stencilData.specialStyles || {};
const sizes = stencilData.sizes || {};

// Group stencils by category
const categories = {};
for (const name of names) {
    // Parse: mxgraph.category.subcategory.name or mxgraph.category.name
    const parts = name.split('.');
    if (parts.length < 3) continue; // Skip invalid names
    
    const category = parts[1]; // e.g., "cisco", "aws", "networks"
    
    if (!categories[category]) {
        categories[category] = [];
    }
    categories[category].push(name);
}

// Check if a style property is color-related
function isColorProperty(key) {
    const colorProps = ['fillColor', 'strokeColor', 'gradientColor', 'fontColor', 
                        'labelBackgroundColor', 'labelBorderColor'];
    // Match fillColor, fillColor2, fillColor3, strokeColor, strokeColor2, etc.
    return colorProps.some(prop => key === prop || key.match(new RegExp(`^${prop}\\d*$`)));
}

// Common default styles to exclude from optional column
const commonDefaults = ['strokeWidth', 'fontSize', 'opacity', 'html', 'aspect', 
                        'verticalLabelPosition', 'verticalAlign', 'labelPosition', 'align'];

// Generate markdown for a category
function generateCategoryMarkdown(category, stencils) {
    const lines = [];
    
    // Title
    const title = category.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    lines.push(`# ${title} Stencils`);
    lines.push('');
    lines.push(`Stencil library: \`mxgraph.${category}.*\``);
    lines.push('');
    lines.push(`Total: ${stencils.length} stencils`);
    lines.push('');
    
    // Sort stencils for consistent output
    stencils.sort();
    
    // Simple list of full names with size
    for (const fullName of stencils) {
        const size = sizes[fullName];
        if (size) {
            const w = Math.round(size.width);
            const h = Math.round(size.height);
            lines.push(`- \`${fullName}\` (${w}×${h})`);
        } else {
            lines.push(`- \`${fullName}\``);
        }
    }
    
    lines.push('');
    lines.push('## Usage Example');
    lines.push('');
    lines.push('```drawio');
    
    // Pick first stencil with color styles for example, or just first one
    let exampleStencil = stencils[0];
    for (const s of stencils) {
        const styles = specialStyles[s] || {};
        if (Object.keys(styles).some(isColorProperty)) {
            exampleStencil = s;
            break;
        }
    }
    
    const exampleStyles = specialStyles[exampleStencil] || {};
    let styleStr = `shape=${exampleStencil};html=1`;
    
    // Add color styles from specialStyles
    const colorStyles = Object.entries(exampleStyles).filter(([k]) => isColorProperty(k));
    if (colorStyles.length > 0) {
        for (const [key, value] of colorStyles) {
            styleStr += `;${key}=${value}`;
        }
    } else {
        styleStr += `;fillColor=#CCCCCC;strokeColor=#6881B3`;
    }
    // Add default optional styles
    styleStr += `;strokeWidth=2`;
    
    lines.push(`<mxfile><diagram id="example" name="Example"><mxGraphModel dx="800" dy="600" grid="1" gridSize="10"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="shape1" value="" style="${styleStr}" parent="1" vertex="1"><mxGeometry x="100" y="100" width="60" height="60" as="geometry"/></mxCell></root></mxGraphModel></diagram></mxfile>`);
    lines.push('```');
    lines.push('');
    
    return lines.join('\n');
}

// Create output directory
const outputDir = path.join(__dirname, '../skills/drawio/stencils');
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}

// Generate markdown files for each category
const sortedCategories = Object.keys(categories).sort();
let totalFiles = 0;

for (const category of sortedCategories) {
    const stencils = categories[category];
    const markdown = generateCategoryMarkdown(category, stencils);
    
    const filename = `${category}.md`;
    const filepath = path.join(outputDir, filename);
    
    fs.writeFileSync(filepath, markdown, 'utf8');
    console.log(`Created: ${filename} (${stencils.length} stencils)`);
    totalFiles++;
}

console.log(`\nTotal: ${totalFiles} category files created in ${outputDir}`);

// Also create an index file
const indexLines = ['# drawio Stencil Reference', ''];

// Add size usage instructions
indexLines.push('## About Stencil Sizes');
indexLines.push('');
indexLines.push('Each stencil is listed with its **original size** in pixels, e.g., `mxgraph.gcp2.bigquery` (172×153).');
indexLines.push('');
indexLines.push('When using stencils in diagrams, you should **scale them proportionally** to fit your layout:');
indexLines.push('');
indexLines.push('```xml');
indexLines.push('<!-- Original: 172×153, scaled to height 30 (ratio preserved) -->');
indexLines.push('<mxCell style="shape=mxgraph.gcp2.bigquery;..." vertex="1">');
indexLines.push('  <mxGeometry width="34" height="30" as="geometry"/>');
indexLines.push('</mxCell>');
indexLines.push('```');
indexLines.push('');
indexLines.push('**Scale formula:** If original is W×H and target height is T, then: `width = W × (T / H)`');
indexLines.push('');
indexLines.push('## Stencil Categories');
indexLines.push('');
indexLines.push('| Category | Count | File |');
indexLines.push('|----------|-------|------|');

for (const category of sortedCategories) {
    const count = categories[category].length;
    const title = category.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    indexLines.push(`| ${title} | ${count} | [${category}.md](${category}.md) |`);
}

fs.writeFileSync(path.join(outputDir, 'README.md'), indexLines.join('\n'), 'utf8');
console.log('Created: README.md (index file)');
