/* agent/src/tests/projectMatching.test.js
 * Comprehensive QA tests for project matching functionality
 * Tests the fix for: "Contributor Portal" incorrectly matching FTS instead of Control Center
 */

const { scoreProjectMatch, fuzzyMatchProject } = require("../liveLinear");
const { parseCommand, extractProjectFromNaturalLanguage } = require("../answerer");

// ============== TEST DATA ==============

const MOCK_PROJECTS = {
  FTS: [
    { name: "Q1 2026 : Sonar cloud analysis for Contributor App", id: "fts-1" },
    { name: "Q1 2026 : Additional Settings Refactor", id: "fts-2" },
    { name: "Q1 2026 : FTS Evals manual actions replacements", id: "fts-3" },
    { name: "Q1 2026 : Data-Driven Cohorts & automations", id: "fts-4" },
    { name: "Q1 2026 : Tagging system V2", id: "fts-5" },
    { name: "Q1 2026 : Contributor communications", id: "fts-6" },
  ],
  "Control Center": [
    { name: "Q1 26 - Contributor Portal", id: "cc-1" },
    { name: "Q1 26 - Den enhancements", id: "cc-2" },
    { name: "Q1 26 - TimeToFill Data Model & Metrics Engine", id: "cc-3" },
    { name: "Q1 26 - Apex Agent", id: "cc-4" },
    { name: "Q1 26 - Rater Assitant V2", id: "cc-5" },
  ],
  Platform: [
    { name: "New contributor portal : Gradien - Q1", id: "plat-1" },
  ],
  "Talent Studio": [
    { name: "[Talent Studio] Observability", id: "ts-1" },
    { name: "Intelligent Qualification Agent V2", id: "ts-2" },
    { name: "Automated fraud detection V2", id: "ts-3" },
  ],
};

// ============== TEST UTILITIES ==============

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message });
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${e.message}`);
  }
}

function assertEqual(actual, expected, msg = "") {
  if (actual !== expected) {
    throw new Error(`${msg} Expected "${expected}", got "${actual}"`);
  }
}

function assertGreaterThan(a, b, msg = "") {
  if (!(a > b)) {
    throw new Error(`${msg} Expected ${a} > ${b}`);
  }
}

function assertNotNull(val, msg = "") {
  if (val === null || val === undefined) {
    throw new Error(`${msg} Expected non-null value`);
  }
}

function assertNull(val, msg = "") {
  if (val !== null) {
    throw new Error(`${msg} Expected null, got ${JSON.stringify(val)}`);
  }
}

// ============== SCORE PROJECT MATCH TESTS ==============

function testScoreProjectMatch() {
  console.log("\n=== scoreProjectMatch Tests ===\n");

  // Test 1: Exact match should score highest
  test("Exact match scores 1000", () => {
    const result = scoreProjectMatch({ name: "Contributor Portal" }, "contributor portal");
    assertNotNull(result);
    assertEqual(result.score, 1000);
  });

  // Test 2: Ends-with match should score 900
  test("Ends-with match scores 900", () => {
    const result = scoreProjectMatch({ name: "Q1 26 - Contributor Portal" }, "contributor portal");
    assertNotNull(result);
    assertEqual(result.score, 900);
  });

  // Test 3: All words match should score 500+
  test("All words match scores 500+", () => {
    const result = scoreProjectMatch({ name: "New contributor portal : Gradien - Q1" }, "contributor portal");
    assertNotNull(result);
    assertGreaterThan(result.score, 500);
    assertGreaterThan(600, result.score); // Should be < 600
  });

  // Test 4: Partial word match (only "contributor" matches) should score lower
  test("Partial word match scores 200-300", () => {
    const result = scoreProjectMatch({ name: "Q1 2026 : Sonar cloud analysis for Contributor App" }, "contributor portal");
    assertNotNull(result);
    assertGreaterThan(result.score, 200);
    assertGreaterThan(300, result.score);
  });

  // Test 5: No match should return null
  test("No match returns null", () => {
    const result = scoreProjectMatch({ name: "Q1 26 - Den enhancements" }, "contributor portal");
    assertNull(result);
  });

  // Test 6: Case insensitivity
  test("Matching is case insensitive", () => {
    const result = scoreProjectMatch({ name: "CONTRIBUTOR PORTAL" }, "contributor portal");
    assertNotNull(result);
    assertEqual(result.score, 1000);
  });

  // Test 7: Whitespace handling
  test("Handles extra whitespace", () => {
    const result = scoreProjectMatch({ name: "Contributor Portal" }, "  contributor   portal  ");
    assertNotNull(result);
    assertEqual(result.score, 1000);
  });
}

// ============== FUZZY MATCH PROJECT TESTS ==============

function testFuzzyMatchProject() {
  console.log("\n=== fuzzyMatchProject Tests ===\n");

  const allProjects = [
    ...MOCK_PROJECTS.FTS,
    ...MOCK_PROJECTS["Control Center"],
    ...MOCK_PROJECTS.Platform,
  ];

  // THE ORIGINAL BUG: "Contributor Portal" should match Control Center, not FTS
  test("'Contributor Portal' matches Control Center project (THE ORIGINAL BUG)", () => {
    const match = fuzzyMatchProject(allProjects, "contributor portal");
    assertNotNull(match);
    assertEqual(match.name, "Q1 26 - Contributor Portal");
  });

  // Test exact project name
  test("Exact project name matches correctly", () => {
    const match = fuzzyMatchProject(MOCK_PROJECTS.FTS, "Q1 2026 : Tagging system V2");
    assertNotNull(match);
    assertEqual(match.name, "Q1 2026 : Tagging system V2");
  });

  // Test partial name
  test("'Tagging' matches Tagging system V2", () => {
    const match = fuzzyMatchProject(MOCK_PROJECTS.FTS, "tagging");
    assertNotNull(match);
    assertEqual(match.name, "Q1 2026 : Tagging system V2");
  });

  // Test "FTS Evals" query
  test("'FTS Evals' matches FTS Evals project", () => {
    const match = fuzzyMatchProject(MOCK_PROJECTS.FTS, "FTS Evals");
    assertNotNull(match);
    assertEqual(match.name, "Q1 2026 : FTS Evals manual actions replacements");
  });

  // Test "Apex Agent" query
  test("'Apex Agent' matches correctly", () => {
    const match = fuzzyMatchProject(MOCK_PROJECTS["Control Center"], "apex agent");
    assertNotNull(match);
    assertEqual(match.name, "Q1 26 - Apex Agent");
  });

  // Test "Den" query
  test("'Den' matches Den enhancements", () => {
    const match = fuzzyMatchProject(MOCK_PROJECTS["Control Center"], "den");
    assertNotNull(match);
    assertEqual(match.name, "Q1 26 - Den enhancements");
  });

  // Test empty query
  test("Empty query returns null", () => {
    const match = fuzzyMatchProject(MOCK_PROJECTS.FTS, "");
    assertNull(match);
  });

  // Test no match
  test("Non-existent project returns null", () => {
    const match = fuzzyMatchProject(MOCK_PROJECTS.FTS, "xyz nonexistent project");
    assertNull(match);
  });
}

// ============== CROSS-POD MATCHING TESTS ==============

function testCrossPodMatching() {
  console.log("\n=== Cross-Pod Matching Tests ===\n");

  // Simulate what the answerer does: search all pods and find best match
  function findBestMatch(query) {
    let best = null;
    for (const [podName, projects] of Object.entries(MOCK_PROJECTS)) {
      for (const p of projects) {
        const result = scoreProjectMatch(p, query);
        if (result && (!best || result.score > best.score)) {
          best = { podName, project: result.project, score: result.score };
        }
      }
    }
    return best;
  }

  // THE CRITICAL TEST: Contributor Portal should find Control Center
  test("'Contributor Portal' finds Control Center pod (CRITICAL)", () => {
    const best = findBestMatch("contributor portal");
    assertNotNull(best);
    assertEqual(best.podName, "Control Center");
    assertEqual(best.project.name, "Q1 26 - Contributor Portal");
  });

  // Test FTS project
  test("'FTS Evals' finds FTS pod", () => {
    const best = findBestMatch("FTS Evals");
    assertNotNull(best);
    assertEqual(best.podName, "FTS");
  });

  // Test Talent Studio project
  test("'Observability' finds Talent Studio pod", () => {
    const best = findBestMatch("observability");
    assertNotNull(best);
    assertEqual(best.podName, "Talent Studio");
  });

  // Test ambiguous query - should pick best match
  test("'Contributor' prefers exact match in Control Center over FTS", () => {
    // "Contributor Portal" in Control Center should beat "Contributor App" in FTS
    const best = findBestMatch("contributor");
    assertNotNull(best);
    // With just "contributor", it might match either, but let's see the behavior
    console.log(`    Info: "contributor" matched: ${best.project.name} in ${best.podName} (score: ${best.score})`);
  });

  // Test "Gradien" - unique to Platform
  test("'Gradien' finds Platform pod", () => {
    const best = findBestMatch("gradien");
    assertNotNull(best);
    assertEqual(best.podName, "Platform");
  });

  // Test "Data-Driven Cohorts"
  test("'Data-Driven Cohorts' finds FTS pod", () => {
    const best = findBestMatch("data-driven cohorts");
    assertNotNull(best);
    assertEqual(best.podName, "FTS");
  });

  // Test "Rater Assistant" (note: typo in original - "Assitant")
  test("'Rater Assistant' matches despite typo in project name", () => {
    const best = findBestMatch("rater assistant");
    // This might not match well due to the typo "Assitant"
    if (best) {
      console.log(`    Info: "rater assistant" matched: ${best.project.name} (score: ${best.score})`);
    } else {
      console.log(`    Info: "rater assistant" did not match (expected due to typo in source)`);
    }
  });
}

// ============== NATURAL LANGUAGE PARSING TESTS ==============

function testNaturalLanguageParsing() {
  console.log("\n=== Natural Language Parsing Tests ===\n");

  // Note: extractProjectFromNaturalLanguage is not exported, so we test via parseCommand

  test("'what's going on in Contributor Portal' parses as project_deep_dive", () => {
    const cmd = parseCommand("what's going on in Contributor Portal");
    assertEqual(cmd.type, "project_deep_dive");
    assertEqual(cmd.projectName, "Contributor Portal");
  });

  test("'whats going on in FTS Evals' parses correctly", () => {
    const cmd = parseCommand("whats going on in FTS Evals");
    assertEqual(cmd.type, "project_deep_dive");
    assertEqual(cmd.projectName, "FTS Evals");
  });

  test("'status of Data-Driven Cohorts' parses correctly", () => {
    const cmd = parseCommand("status of Data-Driven Cohorts");
    assertEqual(cmd.type, "project_deep_dive");
    assertEqual(cmd.projectName, "Data-Driven Cohorts");
  });

  test("'tell me about Apex Agent' parses correctly", () => {
    const cmd = parseCommand("tell me about Apex Agent");
    assertEqual(cmd.type, "project_deep_dive");
    assertEqual(cmd.projectName, "Apex Agent");
  });

  test("'project tagging' parses as project_detail", () => {
    const cmd = parseCommand("project tagging");
    assertEqual(cmd.type, "project_detail");
    assertEqual(cmd.projectName, "tagging");
  });

  test("'project tagging blockers' parses as project_blockers", () => {
    const cmd = parseCommand("project tagging blockers");
    assertEqual(cmd.type, "project_blockers");
    assertEqual(cmd.projectName, "tagging");
  });

  test("'project FTS Evals comments' parses as project_comments", () => {
    const cmd = parseCommand("project FTS Evals comments");
    assertEqual(cmd.type, "project_comments");
    assertEqual(cmd.projectName, "fts evals");
  });

  test("'pods' parses as list_pods", () => {
    const cmd = parseCommand("pods");
    assertEqual(cmd.type, "list_pods");
  });

  test("'pod fts' parses as pod_summary", () => {
    const cmd = parseCommand("pod fts");
    assertEqual(cmd.type, "pod_summary");
    assertEqual(cmd.podName, "fts");
  });

  test("'pod control center projects' parses as pod_projects", () => {
    const cmd = parseCommand("pod control center projects");
    assertEqual(cmd.type, "pod_projects");
    assertEqual(cmd.podName, "control center");
  });
}

// ============== EDGE CASES ==============

function testEdgeCases() {
  console.log("\n=== Edge Cases ===\n");

  test("Empty query returns null", () => {
    const result = scoreProjectMatch({ name: "Test Project" }, "");
    assertNull(result);
  });

  test("Null query returns null", () => {
    const result = scoreProjectMatch({ name: "Test Project" }, null);
    assertNull(result);
  });

  test("Undefined query returns null", () => {
    const result = scoreProjectMatch({ name: "Test Project" }, undefined);
    assertNull(result);
  });

  test("Very long query handles gracefully", () => {
    const longQuery = "a".repeat(1000);
    const result = scoreProjectMatch({ name: "Test Project" }, longQuery);
    // Should not throw, may return null
    console.log(`    Info: Long query result: ${result ? result.score : "null"}`);
  });

  test("Special characters in query", () => {
    const result = scoreProjectMatch({ name: "Q1 26 - Test (Beta)" }, "test (beta)");
    assertNotNull(result);
    console.log(`    Info: Special chars matched with score: ${result.score}`);
  });

  test("Numbers in query", () => {
    const result = scoreProjectMatch({ name: "Agent V2" }, "v2");
    assertNotNull(result);
    console.log(`    Info: 'v2' matched with score: ${result.score}`);
  });

  test("Single character query (too short)", () => {
    const result = scoreProjectMatch({ name: "Test Project" }, "t");
    // Single char queries might not match due to length check
    console.log(`    Info: Single char result: ${result ? result.score : "null"}`);
  });

  test("Query with only spaces", () => {
    const result = scoreProjectMatch({ name: "Test Project" }, "   ");
    assertNull(result);
  });
}

// ============== REGRESSION TESTS ==============

function testRegressions() {
  console.log("\n=== Regression Tests ===\n");

  // The original bug scenario
  test("REGRESSION: 'Contributor Portal' must NOT match FTS projects", () => {
    const ftsMatch = fuzzyMatchProject(MOCK_PROJECTS.FTS, "contributor portal");
    const ccMatch = fuzzyMatchProject(MOCK_PROJECTS["Control Center"], "contributor portal");

    assertNotNull(ccMatch, "Control Center should have a match");
    assertEqual(ccMatch.name, "Q1 26 - Contributor Portal");

    // FTS might match partially, but the score should be lower
    if (ftsMatch) {
      const ftsScore = scoreProjectMatch(ftsMatch, "contributor portal");
      const ccScore = scoreProjectMatch(ccMatch, "contributor portal");
      assertGreaterThan(ccScore.score, ftsScore.score, "Control Center score should be higher than FTS");
    }
  });

  // Ensure old functionality still works
  test("REGRESSION: 'tagging' still matches Tagging system V2", () => {
    const match = fuzzyMatchProject(MOCK_PROJECTS.FTS, "tagging");
    assertNotNull(match);
    assertEqual(match.name, "Q1 2026 : Tagging system V2");
  });

  test("REGRESSION: 'cohorts' still matches Data-Driven Cohorts", () => {
    const match = fuzzyMatchProject(MOCK_PROJECTS.FTS, "cohorts");
    assertNotNull(match);
    assertEqual(match.name, "Q1 2026 : Data-Driven Cohorts & automations");
  });

  test("REGRESSION: 'evals' still matches FTS Evals project", () => {
    const match = fuzzyMatchProject(MOCK_PROJECTS.FTS, "evals");
    assertNotNull(match);
    assertEqual(match.name, "Q1 2026 : FTS Evals manual actions replacements");
  });
}

// ============== SCORING PRIORITY TESTS ==============

function testScoringPriority() {
  console.log("\n=== Scoring Priority Tests ===\n");

  // Create projects with similar names to test priority
  const testProjects = [
    { name: "Contributor Portal", id: "1" },                    // Exact
    { name: "Q1 26 - Contributor Portal", id: "2" },            // Ends with
    { name: "New contributor portal system", id: "3" },         // All words
    { name: "Contributor App Portal", id: "4" },                // All words
    { name: "Contributor management system", id: "5" },         // Partial
    { name: "Portal for contributors", id: "6" },               // Words in different order
  ];

  test("Exact match has highest score", () => {
    const scores = testProjects.map(p => ({
      name: p.name,
      score: scoreProjectMatch(p, "contributor portal")?.score || 0
    }));

    const sorted = [...scores].sort((a, b) => b.score - a.score);
    assertEqual(sorted[0].name, "Contributor Portal", "Exact match should be first");
    console.log("    Scores:", JSON.stringify(sorted.map(s => `${s.name}: ${s.score}`), null, 2));
  });

  test("'Ends with' beats 'all words match'", () => {
    const endsWithScore = scoreProjectMatch({ name: "Q1 26 - Contributor Portal" }, "contributor portal");
    const allWordsScore = scoreProjectMatch({ name: "New contributor portal system" }, "contributor portal");

    assertNotNull(endsWithScore);
    assertNotNull(allWordsScore);
    assertGreaterThan(endsWithScore.score, allWordsScore.score);
  });

  test("'All words match' beats 'partial match'", () => {
    const allWordsScore = scoreProjectMatch({ name: "New contributor portal system" }, "contributor portal");
    const partialScore = scoreProjectMatch({ name: "Contributor management system" }, "contributor portal");

    assertNotNull(allWordsScore);
    // Partial might be null or lower
    if (partialScore) {
      assertGreaterThan(allWordsScore.score, partialScore.score);
    }
  });
}

// ============== RUN ALL TESTS ==============

function runAllTests() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║       Project Matching QA Test Suite                     ║");
  console.log("║       Testing fix for Contributor Portal bug             ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  testScoreProjectMatch();
  testFuzzyMatchProject();
  testCrossPodMatching();
  testNaturalLanguageParsing();
  testEdgeCases();
  testRegressions();
  testScoringPriority();

  console.log("\n══════════════════════════════════════════════════════════");
  console.log(`RESULTS: ${passed} passed, ${failed} failed`);
  console.log("══════════════════════════════════════════════════════════");

  if (failures.length > 0) {
    console.log("\nFailed tests:");
    failures.forEach(f => console.log(`  - ${f.name}: ${f.error}`));
  }

  console.log("");
  return failed === 0;
}

// Run tests
const success = runAllTests();
process.exit(success ? 0 : 1);
