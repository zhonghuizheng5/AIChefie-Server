const serverURL = process.env.COOKLENS_SERVER_URL || "http://127.0.0.1:8787";

if (process.env.RUN_PAID_BENCHMARK !== "1") {
  console.error(
    "This benchmark makes paid OpenRouter image requests. "
    + "Run with RUN_PAID_BENCHMARK=1 after starting CookLensServer."
  );
  process.exit(1);
}

const cases = [
  {
    category: "Chicken",
    ingredient: "Chicken breast",
    options: [
      ["Pan-seared chicken breast", "Pan-sear the chicken breast until cooked through."],
      ["Roasted chicken breast", "Roast the chicken breast until browned and cooked through."],
    ],
  },
  {
    category: "Fish",
    ingredient: "Salmon fillet",
    options: [
      ["Pan-seared salmon", "Pan-sear the salmon fillet until just cooked."],
      ["Roasted salmon", "Roast the salmon fillet until flaky."],
    ],
  },
  {
    category: "Beef",
    ingredient: "Beef steak",
    options: [
      ["Pan-seared beef steak", "Pan-sear the beef steak to the desired doneness."],
      ["Roasted beef steak", "Roast the beef steak to the desired doneness."],
    ],
  },
  {
    category: "Goose",
    ingredient: "Canada goose breast",
    options: [
      ["Pan-seared goose breast", "Pan-sear the goose breast until safely cooked."],
      ["Roasted goose breast", "Roast the goose breast until safely cooked."],
    ],
  },
  {
    category: "Single vegetable",
    ingredient: "Broccoli",
    options: [
      ["Roasted broccoli", "Roast the broccoli until browned and tender."],
      ["Pan-seared broccoli", "Pan-sear the broccoli until tender."],
    ],
  },
  {
    category: "Mixed vegetables",
    ingredient: ["Carrot", "Broccoli", "Cauliflower"],
    options: [
      ["Roasted mixed vegetables", "Roast the carrot, broccoli, and cauliflower until tender."],
      ["Pan-seared mixed vegetables", "Pan-sear the carrot, broccoli, and cauliflower until tender."],
    ],
  },
];

const results = [];

for (const testCase of cases) {
  for (const [optionIndex, option] of testCase.options.entries()) {
    const ingredients = Array.isArray(testCase.ingredient)
      ? testCase.ingredient
      : [testCase.ingredient];
    const [dishName, step] = option;
    const startedAt = Date.now();

    try {
      const response = await fetch(`${serverURL}/api/dish-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dishName,
          detectedIngredients: ingredients,
          pantrySeasoningsUsed: ["Salt", "Cooking oil"],
          steps: [step],
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error || `HTTP ${response.status}`);
      }

      const attempts = payload.source?.generationAttempts || [];
      results.push({
        category: testCase.category,
        option: optionIndex + 1,
        dishName,
        success: Boolean(payload.imageDataURL),
        attempts: payload.attempts,
        firstPass: Boolean(payload.imageDataURL) && payload.attempts === 1,
        fallbackPassed: Boolean(payload.imageDataURL) && payload.attempts === 2,
        invalidImageReturned: Boolean(payload.imageDataURL && payload.imageError),
        rejectedItems: attempts.flatMap(
          (attempt) => attempt.unapprovedFoodItems || []
        ),
        modelsUsed: payload.source?.modelsUsed || [],
        reportedCostUSD: payload.source?.reportedCostUSD ?? null,
        estimatedCostUSD: payload.source?.estimatedCostUSD ?? null,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      results.push({
        category: testCase.category,
        option: optionIndex + 1,
        dishName,
        success: false,
        error: error.message,
        durationMs: Date.now() - startedAt,
      });
    }
  }
}

const firstPassCount = results.filter((result) => result.firstPass).length;
const finalPassCount = results.filter((result) => result.success).length;
const invalidReturnedCount = results.filter(
  (result) => result.invalidImageReturned
).length;
const totalCostUSD = results.reduce(
  (total, result) =>
    total + (result.reportedCostUSD ?? result.estimatedCostUSD ?? 0),
  0
);
const firstPassRate = firstPassCount / results.length;
const finalPassRate = finalPassCount / results.length;
const evaluatedPrimaryModel = results.find(
  (result) => result.modelsUsed?.length
)?.modelsUsed[0] || "unknown";
let recommendation;
if (firstPassRate >= 0.8) {
  recommendation = `Keep ${evaluatedPrimaryModel} as the primary image model.`;
} else if (evaluatedPrimaryModel === "black-forest-labs/flux.2-klein-4b") {
  recommendation = "Use Seedream 4.5 as the primary image model.";
} else {
  recommendation =
    `${evaluatedPrimaryModel} missed the first-pass target; `
    + "keep strict validation and improve the image prompt before rollout.";
}

console.table(results);
console.log(JSON.stringify({
  totalImages: results.length,
  firstPassCount,
  firstPassRate,
  finalPassCount,
  finalPassRate,
  invalidReturnedCount,
  totalCostUSD: Math.round(totalCostUSD * 1_000_000) / 1_000_000,
  evaluatedPrimaryModel,
  averageCostPerAcceptedImageUSD:
    finalPassCount > 0
      ? Math.round((totalCostUSD / finalPassCount) * 1_000_000) / 1_000_000
      : null,
  recommendation,
}, null, 2));

const passed =
  invalidReturnedCount === 0
  && firstPassRate >= 0.8
  && finalPassRate >= 0.95;
process.exit(passed ? 0 : 2);
