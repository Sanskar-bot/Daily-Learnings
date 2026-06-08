#!/usr/bin/env node
/**
 * generate-portfolio-data.js
 * ---------------------------
 * Scans all daily learning markdown files in the repository and generates
 * structured JSON files in portfolio-data/ for portfolio website consumption.
 *
 * Output files:
 *   portfolio-data/timeline.json       — full chronological list of entries
 *   portfolio-data/latest.json         — single newest entry
 *   portfolio-data/stats.json          — aggregate statistics
 *   portfolio-data/tags.json           — tag frequency map
 *   portfolio-data/knowledge-base.json — AI-assistant-ready knowledge entries
 *   portfolio-data/featured.json       — top entries by complexity/depth
 *
 * Usage:
 *   node scripts/generate-portfolio-data.js
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── Configuration ───────────────────────────────────────────────────────────

const REPO_ROOT      = path.resolve(__dirname, '..');
const OUTPUT_DIR     = path.join(REPO_ROOT, 'portfolio-data');
const GITHUB_REPO    = 'https://github.com/Sanskar-bot/Daily-Learnings';
const GITHUB_BRANCH  = 'main';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Recursively walk a directory and collect all .md file absolute paths.
 * Skips node_modules, .git, scripts, and portfolio-data directories.
 */
function walkMarkdownFiles(dir, results = []) {
  const SKIP_DIRS = new Set(['.git', 'node_modules', 'scripts', 'portfolio-data', '.github']);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        walkMarkdownFiles(path.join(dir, entry.name), results);
      }
    } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md') {
      results.push(path.join(dir, entry.name));
    }
  }
  return results;
}

/**
 * Parse a filename like "08-06-2026.md" or "2026-06-08" into ISO date string.
 * Returns null if unparseable.
 */
function parseDateFromFilename(filename) {
  const base = path.basename(filename, '.md');

  // Format: DD-MM-YYYY (e.g. 08-06-2026)
  const ddmmyyyy = base.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (ddmmyyyy) {
    const [, dd, mm, yyyy] = ddmmyyyy;
    const date = new Date(`${yyyy}-${mm}-${dd}`);
    if (!isNaN(date.getTime())) return `${yyyy}-${mm}-${dd}`;
  }

  // Format: YYYY-MM-DD (e.g. 2026-06-08)
  const yyyymmdd = base.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (yyyymmdd) {
    const [, yyyy, mm, dd] = yyyymmdd;
    const date = new Date(`${yyyy}-${mm}-${dd}`);
    if (!isNaN(date.getTime())) return `${yyyy}-${mm}-${dd}`;
  }

  // Format: DD-MM-DD-YYYY special case (e.g. 02-09-05-2026)
  const special = base.match(/^(\d{2})-\d{2}-(\d{2})-(\d{4})$/);
  if (special) {
    const [, dd, mm, yyyy] = special;
    const date = new Date(`${yyyy}-${mm}-${dd}`);
    if (!isNaN(date.getTime())) return `${yyyy}-${mm}-${dd}`;
  }

  return null;
}

/**
 * Extract the H1 date header from the markdown content.
 * Looks for lines like: # 2026-06-08
 */
function extractDateFromContent(content) {
  const match = content.match(/^#\s+(\d{4}-\d{2}-\d{2})/m);
  if (match) return match[1];
  return null;
}

/**
 * Extract the primary title (first H3 heading under "## What I Learned").
 * Falls back to the first H3 or H2 found.
 */
function extractTitle(content) {
  // Try to find the first ### after ## What I Learned
  const learnedSection = content.match(/##\s+What I Learned[\s\S]*?###\s+(.+)/);
  if (learnedSection) return learnedSection[1].trim();

  // Fall back to first ### heading
  const h3 = content.match(/^###\s+(.+)/m);
  if (h3) return h3[1].trim();

  // Fall back to first ## heading that isn't a meta-section
  const h2 = content.match(/^##\s+(?!What I|What I Practiced|Questions|Resources|Stats|Weekly)(.+)/m);
  if (h2) return h2[1].trim();

  return 'Daily Learning';
}

/**
 * Extract a plain-text summary from the content.
 * Uses the blockquote "Context:" if present, otherwise the first paragraph of
 * the "What I Learned" section.
 */
function extractSummary(content) {
  // Try the > **Context:** blockquote
  const contextMatch = content.match(/>\s*\*\*Context:\*\*\s*([\s\S]*?)(?=\n\n|\n>|\n#)/);
  if (contextMatch) {
    return contextMatch[1]
      .replace(/\n>\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 280);
  }

  // Try first non-empty paragraph after the title section
  const lines = content.split('\n');
  let inLearnedSection = false;
  const paragraphLines = [];

  for (const line of lines) {
    if (line.match(/^##\s+What I Learned/)) { inLearnedSection = true; continue; }
    if (inLearnedSection && line.match(/^##\s+/)) break;
    if (inLearnedSection) {
      const stripped = line.replace(/^#+\s+/, '').replace(/\*\*/g, '').trim();
      if (stripped && !stripped.startsWith('```') && !stripped.startsWith('|') && !stripped.startsWith('-')) {
        paragraphLines.push(stripped);
        if (paragraphLines.join(' ').length > 200) break;
      }
    }
  }

  if (paragraphLines.length) {
    return paragraphLines.join(' ').substring(0, 280).trim();
  }

  return 'Daily learning entry.';
}

/**
 * Extract technology names by scanning code blocks, inline code, and known keywords.
 */
function extractTechnologies(content) {
  const techs = new Set();

  // Detect code block languages
  const codeblockLangs = content.matchAll(/```(\w+)/g);
  const langMap = {
    typescript: 'TypeScript', ts: 'TypeScript',
    javascript: 'JavaScript', js: 'JavaScript',
    python: 'Python', py: 'Python',
    java: 'Java', bash: 'Bash', sh: 'Bash',
    sql: 'SQL', yaml: 'YAML', yml: 'YAML',
    json: 'JSON', html: 'HTML', css: 'CSS',
    rust: 'Rust', go: 'Go', kotlin: 'Kotlin',
    dockerfile: 'Docker', docker: 'Docker',
    xml: 'XML', graphql: 'GraphQL',
  };
  for (const m of codeblockLangs) {
    const lang = m[1].toLowerCase();
    if (langMap[lang]) techs.add(langMap[lang]);
  }

  // Detect known technology mentions in plain text
  const techPatterns = [
    [/\bJWT\b/g, 'JWT'],
    [/\bSpring\s?Boot\b/gi, 'Spring Boot'],
    [/\bSpring\s?Security\b/gi, 'Spring Security'],
    [/\bNode\.?js\b/gi, 'Node.js'],
    [/\bReact\b/g, 'React'],
    [/\bNext\.?js\b/gi, 'Next.js'],
    [/\bPostgres(?:QL)?\b/gi, 'PostgreSQL'],
    [/\bMySQL\b/gi, 'MySQL'],
    [/\bMongoDB\b/gi, 'MongoDB'],
    [/\bRedis\b/gi, 'Redis'],
    [/\bDocker\b/gi, 'Docker'],
    [/\bKubernetes\b/gi, 'Kubernetes'],
    [/\bGitHub\s?Actions\b/gi, 'GitHub Actions'],
    [/\bAWS\b/g, 'AWS'],
    [/\bGCP\b/g, 'GCP'],
    [/\bAzure\b/g, 'Azure'],
    [/\bSalesforce\b/gi, 'Salesforce'],
    [/\bTrailhead\b/gi, 'Salesforce Trailhead'],
    [/\bAES[- ]?(?:256)?[- ]?GCM\b/gi, 'AES-256-GCM'],
    [/\bArgon2(?:id)?\b/gi, 'Argon2id'],
    [/\bBIP[- ]?39\b/gi, 'BIP-39'],
    [/\blibsodium\b/gi, 'libsodium'],
    [/\bWebCrypto\b/gi, 'WebCrypto API'],
    [/\bTypeScript\b/gi, 'TypeScript'],
    [/\bJavaScript\b/gi, 'JavaScript'],
    [/\bPython\b/gi, 'Python'],
    [/\bLinux\b/gi, 'Linux'],
    [/\bNIST\b/g, 'NIST'],
    [/\bOSI\s?[Mm]odel\b/gi, 'OSI Model'],
    [/\bTCP[/\\]?UDP\b/gi, 'TCP/UDP'],
    [/\bHTTPS?\b/g, 'HTTP/HTTPS'],
    [/\bREST(?:ful)?\s?API\b/gi, 'REST API'],
    [/\bgRPC\b/g, 'gRPC'],
    [/\bGraphQL\b/gi, 'GraphQL'],
    [/\bnpm\b/g, 'npm'],
    [/\bpnpm\b/g, 'pnpm'],
    [/\bGit\b/g, 'Git'],
    [/\bVite\b/gi, 'Vite'],
  ];

  for (const [regex, name] of techPatterns) {
    if (regex.test(content)) techs.add(name);
    regex.lastIndex = 0; // reset global regex
  }

  return [...techs].sort();
}

/**
 * Extract topic keywords from H3/H4 headings in the "What I Learned" section.
 */
function extractTopics(content) {
  const topics = new Set();
  const learnedMatch = content.match(/##\s+What I Learned([\s\S]*?)(?=\n##\s+|$)/);
  if (!learnedMatch) return [];

  const section = learnedMatch[1];
  const headings = section.matchAll(/^#{3,4}\s+(.+)/gm);
  for (const h of headings) {
    const topic = h[1]
      .replace(/`[^`]+`/g, '') // remove inline code
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // remove links
      .replace(/[*_]/g, '')    // remove bold/italic markers
      .trim();
    if (topic && topic.length > 2 && topic.length < 120) {
      topics.add(topic);
    }
  }
  return [...topics];
}

/**
 * Derive tags from technologies, topics, and content keywords.
 */
function deriveTags(technologies, topics, content) {
  const tags = new Set([...technologies]);

  // Domain tags from content
  const domainTags = [
    [/\bcyber(?:security)?\b/gi, 'Cybersecurity'],
    [/\bcryptograph/gi, 'Cryptography'],
    [/\bnetwork(?:ing)?\b/gi, 'Networking'],
    [/\bpassword\s?manager\b/gi, 'Password Manager'],
    [/\bransomware\b/gi, 'Ransomware'],
    [/\bpenetration\s?test/gi, 'Penetration Testing'],
    [/\bauth(?:entication|orization)?\b/gi, 'Authentication'],
    [/\bencrypt/gi, 'Encryption'],
    [/\bhashing\b/gi, 'Hashing'],
    [/\bAI\b|artificial\s?intelligence/gi, 'AI/ML'],
    [/\bmachine\s?learning\b/gi, 'AI/ML'],
    [/\bdata\s?modeling\b/gi, 'Data Modeling'],
    [/\bCIA\s?[Tt]riad\b/g, 'CIA Triad'],
    [/\bsecurity\b/gi, 'Security'],
    [/\bweb\s?dev/gi, 'Web Development'],
    [/\bbackend\b/gi, 'Backend'],
    [/\bfrontend\b/gi, 'Frontend'],
    [/\bfull[- ]?stack\b/gi, 'Full Stack'],
    [/\bcloud\b/gi, 'Cloud'],
    [/\bdevops\b/gi, 'DevOps'],
    [/\blinux\b/gi, 'Linux'],
    [/\bsalesforce\b/gi, 'Salesforce'],
    [/\btrailhead\b/gi, 'Salesforce'],
    [/\bapex\b/gi, 'Salesforce'],
    [/\bOSI\b/g, 'Networking'],
    [/\bprotocol\b/gi, 'Networking'],
    [/\bopen[- ]?source\b/gi, 'Open Source'],
    [/\bperformance\b/gi, 'Performance'],
    [/\btesting\b/gi, 'Testing'],
    [/\bvault\b/gi, 'Password Manager'],
  ];

  for (const [regex, tag] of domainTags) {
    if (regex.test(content)) tags.add(tag);
    regex.lastIndex = 0;
  }

  return [...tags].sort();
}

/**
 * Estimate difficulty based on content complexity signals.
 */
function estimateDifficulty(content, topics) {
  let score = 0;

  // Code blocks — more code = more advanced
  const codeBlocks = (content.match(/```/g) || []).length / 2;
  score += Math.min(codeBlocks * 5, 30);

  // Length signal
  const wordCount = content.split(/\s+/).length;
  if (wordCount > 1000) score += 20;
  else if (wordCount > 500) score += 10;

  // Advanced keyword signals
  const advancedKeywords = [
    'cryptograph', 'algorithm', 'implementation', 'architecture',
    'AES', 'RSA', 'Argon2', 'WebAssembly', 'Wasm', 'kernel',
    'concurrency', 'async', 'buffer overflow', 'exploit',
    'exploit', 'penetration', 'reverse engineering',
  ];
  for (const kw of advancedKeywords) {
    if (content.toLowerCase().includes(kw.toLowerCase())) score += 8;
  }

  // Topic count
  score += Math.min(topics.length * 3, 15);

  if (score >= 60) return 'Advanced';
  if (score >= 30) return 'Intermediate';
  return 'Beginner';
}

/**
 * Extract any GitHub/Drive/external links from the Resources section.
 */
function extractLinks(content) {
  const links = [];
  const resourcesMatch = content.match(/##\s+Resources Used([\s\S]*?)(?=\n##\s+|$)/);
  if (!resourcesMatch) return links;

  const section = resourcesMatch[1];
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let m;
  while ((m = linkRegex.exec(section)) !== null) {
    links.push({ label: m[1].trim(), url: m[2].trim() });
  }
  return links;
}

/**
 * Extract concepts from bullet points in the "What I Practiced / Built" section.
 */
function extractConcepts(content) {
  const concepts = [];
  const practiceMatch = content.match(/##\s+What I Practiced\s*\/?\s*Built([\s\S]*?)(?=\n##\s+|$)/);
  if (!practiceMatch) return concepts;

  const lines = practiceMatch[1].split('\n');
  for (const line of lines) {
    const item = line.replace(/^[-*+]\s+/, '').replace(/\*\*/g, '').trim();
    if (item && item.length > 5 && item.length < 200) {
      concepts.push(item);
    }
  }
  return concepts.slice(0, 10);
}

/**
 * Build a GitHub raw URL for a given file path relative to repo root.
 */
function buildGithubUrl(filePath) {
  const relative = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
  return `${GITHUB_REPO}/blob/${GITHUB_BRANCH}/${encodeURIComponent(relative).replace(/%2F/g, '/')}`;
}

/**
 * Parse a single markdown file and return a structured entry object.
 * Returns null if the file cannot be parsed as a learning entry.
 */
function parseMarkdownFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  // Normalize line endings
  const content = raw.replace(/\r\n/g, '\n');

  // Determine date — prefer H1 content header, fall back to filename
  const date = extractDateFromContent(content) || parseDateFromFilename(filePath);
  if (!date) return null; // skip non-date files

  const sourceFile = path.basename(filePath);
  const relPath    = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
  const title      = extractTitle(content);
  const summary    = extractSummary(content);
  const technologies = extractTechnologies(content);
  const topics     = extractTopics(content);
  const tags       = deriveTags(technologies, topics, content);
  const difficulty = estimateDifficulty(content, topics);
  const links      = extractLinks(content);
  const concepts   = extractConcepts(content);
  const githubUrl  = buildGithubUrl(filePath);
  const wordCount  = content.split(/\s+/).length;

  return {
    date,
    sourceFile,
    relPath,
    title,
    summary,
    technologies,
    topics,
    tags,
    difficulty,
    links,
    concepts,
    githubUrl,
    wordCount,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log('🔍  Scanning repository for learning files…');

  // 1. Collect all markdown files
  const mdFiles = walkMarkdownFiles(REPO_ROOT);
  console.log(`   Found ${mdFiles.length} markdown file(s).`);

  // 2. Parse each file
  const rawEntries = mdFiles
    .map(parseMarkdownFile)
    .filter(Boolean);

  if (rawEntries.length === 0) {
    console.error('❌  No parseable learning entries found. Aborting.');
    process.exit(1);
  }

  // 3. Sort chronologically (oldest first)
  rawEntries.sort((a, b) => a.date.localeCompare(b.date));

  // 4. Assign sequential IDs
  const entries = rawEntries.map((entry, idx) => ({
    ...entry,
    id: `day-${String(idx + 1).padStart(3, '0')}`,
  }));

  console.log(`   Parsed ${entries.length} valid learning entries.`);

  // ── Ensure output directory exists ──────────────────────────────────────────
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    console.log(`   Created directory: portfolio-data/`);
  }

  // ── timeline.json ────────────────────────────────────────────────────────────
  const timeline = entries.map(e => ({
    id:         e.id,
    date:       e.date,
    title:      e.title,
    summary:    e.summary,
    tags:       e.tags,
    difficulty: e.difficulty,
    sourceFile: e.sourceFile,
    githubUrl:  e.githubUrl,
    wordCount:  e.wordCount,
  }));

  writeJSON('timeline.json', timeline);
  console.log('   ✓  timeline.json');

  // ── latest.json ──────────────────────────────────────────────────────────────
  const last = entries[entries.length - 1];
  const latest = {
    id:         last.id,
    date:       last.date,
    title:      last.title,
    summary:    last.summary,
    tags:       last.tags,
    difficulty: last.difficulty,
    githubUrl:  last.githubUrl,
    generatedAt: new Date().toISOString(),
  };

  writeJSON('latest.json', latest);
  console.log('   ✓  latest.json');

  // ── stats.json ───────────────────────────────────────────────────────────────
  const allTags         = entries.flatMap(e => e.tags);
  const allTopics       = entries.flatMap(e => e.topics);
  const allTechnologies = entries.flatMap(e => e.technologies);
  const uniqueTags      = new Set(allTags);
  const uniqueTopics    = new Set(allTopics);
  const uniqueTechs     = new Set(allTechnologies);

  const difficultyBreakdown = { Beginner: 0, Intermediate: 0, Advanced: 0 };
  for (const e of entries) difficultyBreakdown[e.difficulty]++;

  const stats = {
    totalLearningDays:      entries.length,
    totalTopics:            uniqueTopics.size,
    totalTags:              uniqueTags.size,
    totalTechnologies:      uniqueTechs.size,
    totalWordsWritten:      entries.reduce((s, e) => s + e.wordCount, 0),
    difficultyBreakdown,
    firstEntry:             entries[0].date,
    lastUpdated:            last.date,
    generatedAt:            new Date().toISOString(),
  };

  writeJSON('stats.json', stats);
  console.log('   ✓  stats.json');

  // ── tags.json ────────────────────────────────────────────────────────────────
  const tagFreq = {};
  for (const tag of allTags) {
    tagFreq[tag] = (tagFreq[tag] || 0) + 1;
  }
  // Sort by frequency descending
  const tagsSorted = Object.fromEntries(
    Object.entries(tagFreq).sort((a, b) => b[1] - a[1])
  );

  writeJSON('tags.json', tagsSorted);
  console.log('   ✓  tags.json');

  // ── featured.json ────────────────────────────────────────────────────────────
  const featured = [...entries]
    .sort((a, b) => {
      // Score: Advanced > Intermediate > Beginner, then by wordCount
      const diffScore = { Advanced: 3, Intermediate: 2, Beginner: 1 };
      const ds = (diffScore[b.difficulty] || 0) - (diffScore[a.difficulty] || 0);
      return ds !== 0 ? ds : b.wordCount - a.wordCount;
    })
    .slice(0, 10)
    .map(e => ({
      id:          e.id,
      date:        e.date,
      title:       e.title,
      summary:     e.summary,
      tags:        e.tags,
      difficulty:  e.difficulty,
      technologies: e.technologies,
      githubUrl:   e.githubUrl,
    }));

  writeJSON('featured.json', featured);
  console.log('   ✓  featured.json');

  // ── knowledge-base.json ──────────────────────────────────────────────────────
  const knowledgeBase = {
    generatedAt: new Date().toISOString(),
    totalEntries: entries.length,
    entries: entries.map(e => ({
      id:           e.id,
      date:         e.date,
      title:        e.title,
      summary:      e.summary,
      concepts:     e.concepts,
      technologies: e.technologies,
      topics:       e.topics,
      tags:         e.tags,
      difficulty:   e.difficulty,
      links:        e.links,
      source:       e.githubUrl,
    })),
  };

  writeJSON('knowledge-base.json', knowledgeBase);
  console.log('   ✓  knowledge-base.json');

  // ─────────────────────────────────────────────────────────────────────────────
  console.log('');
  console.log(`✅  portfolio-data/ generated successfully.`);
  console.log(`    Entries : ${entries.length}`);
  console.log(`    Tags    : ${uniqueTags.size}`);
  console.log(`    Topics  : ${uniqueTopics.size}`);
  console.log(`    Techs   : ${uniqueTechs.size}`);
  console.log(`    Latest  : ${last.date} — ${last.title}`);
}

function writeJSON(filename, data) {
  const outPath = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
}

main();
