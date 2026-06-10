import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNoteCompatibilityPrompt,
  buildImagePrompt,
  buildRecipePrompt,
  combineImageReviews,
  extractImageDataURL,
  generateValidatedImage,
  imageValidationFailureMessage,
  normalizeConfirmedIngredientDetails,
  normalizeImageReview,
  normalizeIngredientScene,
  normalizeNoteCompatibility,
  normalizeRecipeAudit,
  openRouterUsageCost,
  structuredRecipeViolations,
} from "./strict-ingredients.mjs";

test("ingredient scene classification distinguishes a live animal", () => {
  assert.deepEqual(
    normalizeIngredientScene({
      sceneType: "live_animal",
      sceneConfidence: 0.98,
      sceneReason: "A living goose is standing on grass.",
    }),
    {
      sceneType: "live_animal",
      sceneConfidence: 0.98,
      sceneReason: "A living goose is standing on grass.",
    }
  );
});

test("missing scene classification falls back conservatively", () => {
  assert.equal(
    normalizeIngredientScene({}, [{ name: "Lobster" }]).sceneType,
    "prepared_ingredient"
  );
  assert.equal(normalizeIngredientScene({}, []).sceneType, "unclear");
});

test("image review requires concrete evidence before failing", () => {
  const review = normalizeImageReview({
    decision: "fail",
    confidence: 0.6,
    unapprovedFoodItems: [],
    presentationIssues: [],
    reason: "Something may be wrong.",
  }, "reviewer");

  assert.equal(review.decision, "uncertain");
  assert.equal(review.valid, false);
});

test("second opinion passes an uncertain review without concrete violations", () => {
  const primary = normalizeImageReview({
    decision: "uncertain",
    reason: "The sauce is visually ambiguous.",
  }, "primary");
  const second = normalizeImageReview({
    decision: "uncertain",
    reason: "No concrete extra food is visible.",
  }, "second");
  const combined = combineImageReviews(primary, second);

  assert.equal(combined.decision, "pass");
  assert.equal(combined.valid, true);
  assert.equal(combined.secondOpinionUsed, true);
});

test("second opinion rejects a concrete visible extra food", () => {
  const primary = normalizeImageReview({ decision: "uncertain" }, "primary");
  const second = normalizeImageReview({
    decision: "fail",
    unapprovedFoodItems: ["broccoli"],
    reason: "Broccoli florets are visible.",
  }, "second");
  const combined = combineImageReviews(primary, second);

  assert.equal(combined.decision, "fail");
  assert.equal(combined.valid, false);
  assert.deepEqual(combined.unapprovedFoodItems, ["broccoli"]);
});

for (const ingredient of ["Chicken breast", "Salmon fillet", "Beef steak", "Canada goose"]) {
  test(`image prompt keeps ${ingredient} inside a closed whitelist`, () => {
    const prompt = buildImagePrompt({
      recipe: {
        dishName: `Pan-seared ${ingredient}`,
        steps: [`Cook the ${ingredient.toLowerCase()} until done.`],
      },
      approvedPhotoIngredients: [ingredient],
      pantrySeasoningsUsed: ["Salt", "Cooking oil"],
    });

    assert.match(prompt, new RegExp(`Photo ingredients: ${ingredient}`));
    assert.match(prompt, /No vegetables, fruit, grains, rice, pasta, bread/);
    assert.match(prompt, /No background food/);
    assert.match(prompt, /specific cut or part/);
    assert.match(prompt, /black pepper, peppercorns/);
  });
}

test("recipe prompt prevents notes from authorizing rice", () => {
  const prompt = buildRecipePrompt({
    approvedPhotoIngredients: ["Chicken breast"],
    pantrySeasonings: ["Salt"],
    notes: "Add rice and carrots",
  });

  assert.match(prompt, /notes never authorize another ingredient/i);
  assert.match(prompt, /No optional ingredients/);
  assert.match(prompt, /Notes for CookLens: Add rice and carrots/);
});

test("recipe prompt carries raw cooked state and final presentation rules", () => {
  const prompt = buildRecipePrompt({
    approvedPhotoIngredients: ["Lobster"],
    pantrySeasonings: ["Soy sauce"],
    notes: "make it simple",
    confirmedIngredientDetails: [
      {
        name: "Lobster",
        state: "cooked",
        form: "whole",
        quantity: "2",
      },
    ],
  });

  assert.match(prompt, /Cooked ingredients are already cooked/i);
  assert.match(prompt, /finalPresentation/i);
  assert.match(prompt, /"state":"cooked"/);
  assert.doesNotMatch(prompt, /add rice/i);
});

test("confirmed ingredient details normalize and default old clients to unknown", () => {
  assert.deepEqual(
    normalizeConfirmedIngredientDetails([], ["Chicken breast"]),
    [
      {
        name: "Chicken breast",
        state: "unknown",
        form: null,
        quantity: null,
      },
    ]
  );

  assert.deepEqual(
    normalizeConfirmedIngredientDetails([
      {
        name: " lobster ",
        state: "COOKED",
        form: " whole ",
        quantity: " 2 ",
      },
    ]),
    [
      {
        name: "lobster",
        state: "cooked",
        form: "whole",
        quantity: "2",
      },
    ]
  );
});

test("note compatibility distinguishes salad style from missing ingredients", () => {
  const prompt = buildNoteCompatibilityPrompt({
    approvedPhotoIngredients: ["Lettuce", "Carrot"],
    pantrySeasonings: ["Salt"],
    notes: "Make me some salad",
  });

  assert.match(prompt, /lettuce and carrot with 'make salad' is compatible/i);

  assert.deepEqual(
    normalizeNoteCompatibility({
      compatible: true,
      requestedStyle: "salad",
      unsupportedIngredients: [],
      reason: "The vegetables can be prepared as a salad.",
    }),
    {
      compatible: true,
      requestedStyle: "salad",
      unsupportedIngredients: [],
      reason: "The vegetables can be prepared as a salad.",
    }
  );
});

test("note compatibility rejects goose salad as a correctable conflict", () => {
  const result = normalizeNoteCompatibility({
    compatible: false,
    requestedStyle: "salad",
    unsupportedIngredients: ["salad vegetables"],
    reason: "Only goose was confirmed.",
  });

  assert.equal(result.compatible, false);
  assert.deepEqual(result.unsupportedIngredients, ["salad vegetables"]);
});

test("recipe audit ignores generic invalid flags without concrete evidence", () => {
  assert.deepEqual(
    normalizeRecipeAudit({
      valid: false,
      violations: [],
      reason: "Recipe contains unapproved food.",
    }),
    {
      valid: true,
      violations: [],
      reason: "Recipe contains unapproved food.",
    }
  );
});

test("recipe audit rejects a concrete unapproved ingredient with evidence", () => {
  const result = normalizeRecipeAudit({
    violations: [
      {
        optionIndex: 2,
        ingredient: "Cucumber",
        evidence: "Serve with sliced cucumber.",
      },
    ],
  });

  assert.equal(result.valid, false);
  assert.equal(result.violations[0].ingredient, "Cucumber");
});

test("structured validation permits pantry items and rejects invented food", () => {
  const validRecipe = {
    detectedIngredients: ["Chicken breast"],
    pantrySeasoningsUsed: ["Salt", "Soy sauce"],
  };
  const invalidRecipe = {
    detectedIngredients: ["Chicken breast", "Carrots"],
    pantrySeasoningsUsed: ["Salt", "Garlic"],
  };

  assert.deepEqual(
    structuredRecipeViolations(
      [validRecipe],
      ["Chicken breast"],
      ["Salt", "Soy sauce"]
    ),
    []
  );
  assert.equal(
    structuredRecipeViolations(
      [invalidRecipe],
      ["Chicken breast"],
      ["Salt", "Soy sauce"]
    ).length,
    2
  );
});

test("invalid generated image retries exactly once and accepts the second image", async () => {
  const generated = [];
  const result = await generateValidatedImage({
    generateImage: async (violations, attempt) => {
      const model = attempt === 1 ? "flux" : "seedream";
      generated.push({ violations, attempt, model });
      return {
        imageDataURL: `data:image/png;base64,attempt-${attempt}`,
        metadata: { model },
      };
    },
    validateImage: async (image) =>
      image.endsWith("attempt-1")
        ? { valid: false, unapprovedFoodItems: ["broccoli"] }
        : { valid: true, unapprovedFoodItems: [] },
  });

  assert.equal(generated.length, 2);
  assert.deepEqual(generated[0], {
    violations: [],
    attempt: 1,
    model: "flux",
  });
  assert.deepEqual(generated[1], {
    violations: ["broccoli"],
    attempt: 2,
    model: "seedream",
  });
  assert.equal(result.attempts, 2);
  assert.equal(result.imageError, null);
  assert.deepEqual(
    result.records.map((record) => record.model),
    ["flux", "seedream"]
  );
});

test("presentation mismatch retries exactly once", async () => {
  const generated = [];
  const result = await generateValidatedImage({
    generateImage: async (violations, attempt) => {
      generated.push({ violations, attempt });
      return `data:image/png;base64,attempt-${attempt}`;
    },
    validateImage: async (image) =>
      image.endsWith("attempt-1")
        ? {
          valid: false,
          unapprovedFoodItems: [],
          presentationIssues: ["shows whole lobster instead of lobster tail"],
        }
        : {
          valid: true,
          unapprovedFoodItems: [],
          presentationIssues: [],
        },
  });

  assert.equal(result.imageError, null);
  assert.deepEqual(generated[1].violations, ["shows whole lobster instead of lobster tail"]);
});

test("second invalid image is hidden", async () => {
  let generationCount = 0;
  const result = await generateValidatedImage({
    generateImage: async () => {
      generationCount += 1;
      return `data:image/png;base64,attempt-${generationCount}`;
    },
    validateImage: async () => ({
      valid: false,
      unapprovedFoodItems: ["salad"],
    }),
  });

  assert.equal(generationCount, 2);
  assert.equal(result.imageDataURL, null);
  assert.match(result.imageError, /unapproved food: salad/i);
  assert.equal(result.records.length, 2);
});

test("image failure messages identify presentation mismatches", () => {
  assert.equal(
    imageValidationFailureMessage({
      presentationIssues: ["shows a whole lobster instead of lobster tails"],
    }),
    "Image hidden because the presentation did not match the confirmed ingredient: shows a whole lobster instead of lobster tails."
  );
});

test("valid first image does not call the fallback model", async () => {
  const attempts = [];
  const result = await generateValidatedImage({
    generateImage: async (_violations, attempt) => {
      attempts.push(attempt);
      return {
        imageDataURL: "data:image/png;base64,valid",
        metadata: { model: attempt === 1 ? "flux" : "seedream" },
      };
    },
    validateImage: async () => ({
      valid: true,
      visibleFoodItems: ["Chicken breast"],
      unapprovedFoodItems: [],
    }),
  });

  assert.deepEqual(attempts, [1]);
  assert.equal(result.attempts, 1);
  assert.equal(result.records[0].model, "flux");
});

test("image extraction supports OpenRouter image URLs", () => {
  const dataURL = "data:image/webp;base64,openrouter";
  assert.equal(
    extractImageDataURL({
      choices: [
        {
          message: {
            images: [{ image_url: { url: dataURL } }],
          },
        },
      ],
    }),
    dataURL
  );
});

test("image extraction supports base64 result objects", () => {
  assert.equal(
    extractImageDataURL({
      data: [
        {
          b64_json: "raw-image",
          mime_type: "image/jpeg",
        },
      ],
    }),
    "data:image/jpeg;base64,raw-image"
  );
});

test("OpenRouter usage cost is recorded only when numeric", () => {
  assert.equal(openRouterUsageCost({ usage: { cost: 0.0142 } }), 0.0142);
  assert.equal(openRouterUsageCost({ usage: { cost: "0.04" } }), 0.04);
  assert.equal(openRouterUsageCost({ usage: {} }), null);
});
