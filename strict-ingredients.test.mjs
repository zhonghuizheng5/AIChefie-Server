import assert from "node:assert/strict";
import test from "node:test";
import {
  applyServerSafetyGuidance,
  buildCuisineAssignmentPlan,
  buildNoteCompatibilityPrompt,
  buildImagePrompt,
  buildRecipePrompt,
  combineImageReviews,
  duplicateRecipeViolations,
  exactRecipeArray,
  extractImageDataURL,
  generateValidatedImage,
  imageValidationFailureMessage,
  normalizeConfirmedIngredientDetails,
  normalizeFavoriteCuisines,
  normalizeImageReview,
  normalizeIngredientCategory,
  normalizeIngredientScene,
  normalizeNoteCompatibility,
  normalizeRecipeAudit,
  normalizeRecipeCount,
  normalizeStructuredSteps,
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

    assert.match(prompt, new RegExp(`Ingredients used by this recipe: ${ingredient}`));
    assert.match(prompt, /No vegetables, fruit, grains, rice, pasta, bread/);
    assert.match(prompt, /No background food/);
    assert.match(prompt, /specific cut or part/);
    assert.match(prompt, /black pepper, peppercorns/);
  });
}

test("recipe prompt asks for the requested recipe count", () => {
  const single = buildRecipePrompt({
    approvedPhotoIngredients: ["Egg"],
    pantrySeasonings: [],
    notes: "",
    recipeCount: 1,
  });
  assert.match(single, /Create exactly one immediately cookable recipe option\./);
  assert.match(single, /"recipes" array with exactly 1 entry\./);
  assert.doesNotMatch(single, /differ meaningfully/);

  const triple = buildRecipePrompt({
    approvedPhotoIngredients: ["Egg"],
    pantrySeasonings: [],
    notes: "",
    recipeCount: 3,
  });
  assert.match(triple, /Create exactly three distinct, immediately cookable recipe options\./);
  assert.match(triple, /"recipes" array with exactly 3 entries\./);
  assert.match(triple, /cooking method, texture, dish format, flavor treatment, or preparation style/);
  assert.match(triple, /Do not return introductory text, Markdown, code fences, or commentary\./);

  const fallback = buildRecipePrompt({
    approvedPhotoIngredients: ["Egg"],
    pantrySeasonings: [],
    notes: "",
  });
  assert.match(fallback, /Create exactly two distinct, immediately cookable recipe options\./);

  const repair = buildRecipePrompt({
    approvedPhotoIngredients: ["Egg"],
    pantrySeasonings: [],
    notes: "",
    recipeCount: 3,
    previousRecipes: [{ dishName: "Egg Bowl" }],
    repairFeedback: "fix it",
  });
  assert.match(repair, /Repair the three recipe options below/);
});

test("favorite cuisine validation drops unknown IDs and duplicates", () => {
  assert.deepEqual(normalizeFavoriteCuisines(undefined), []);
  assert.deepEqual(normalizeFavoriteCuisines("chinese"), []);
  assert.deepEqual(normalizeFavoriteCuisines([]), []);

  const cuisines = normalizeFavoriteCuisines([
    "korean",
    " Chinese ",
    "atlantis",
    "korean",
    42,
    "west-african",
  ]);
  assert.deepEqual(cuisines, [
    { id: "korean", displayName: "Korean" },
    { id: "chinese", displayName: "Chinese" },
    { id: "west-african", displayName: "West African" },
  ]);
});

test("cuisine assignment is deterministic and round-robin", () => {
  const cuisines = normalizeFavoriteCuisines(["chinese", "korean"]);
  assert.deepEqual(buildCuisineAssignmentPlan(3, cuisines), [
    { optionIndex: 1, cuisineID: "chinese", displayName: "Chinese" },
    { optionIndex: 2, cuisineID: "korean", displayName: "Korean" },
    { optionIndex: 3, cuisineID: "chinese", displayName: "Chinese" },
  ]);
  assert.deepEqual(buildCuisineAssignmentPlan(2, []), [
    { optionIndex: 1, cuisineID: null, displayName: null },
    { optionIndex: 2, cuisineID: null, displayName: null },
  ]);
});

test("recipe prompt treats favorite cuisines as style only", () => {
  const base = {
    approvedPhotoIngredients: ["Chicken breast", "Broccoli"],
    pantrySeasonings: ["Salt", "Soy sauce"],
    notes: "Keep it simple",
    recipeCount: 3,
  };

  const withCuisines = buildRecipePrompt({
    ...base,
    favoriteCuisines: normalizeFavoriteCuisines(["chinese", "korean"]),
  });
  assert.match(withCuisines, /FAVORITE CUISINES:/);
  assert.match(withCuisines, /favorite cuisines: Chinese, Korean\./);
  assert.match(withCuisines, /never authorizes an ingredient outside the whitelist/);
  assert.match(withCuisines, /Cuisine assignment plan:/);
  assert.match(withCuisines, /Do not create fusion food unless the user explicitly asks/);
  assert.match(withCuisines, /cuisineMatch='traditional'/);

  const singleRecipe = buildRecipePrompt({
    ...base,
    recipeCount: 1,
    favoriteCuisines: normalizeFavoriteCuisines(["chinese", "korean"]),
  });
  assert.match(singleRecipe, /"optionIndex":1/);
  assert.match(singleRecipe, /"displayName":"Chinese"/);

  const withoutCuisines = buildRecipePrompt(base);
  assert.doesNotMatch(withoutCuisines, /FAVORITE CUISINES:/);
  assert.match(withoutCuisines, /Set cuisineInfluence to null and cuisineMatch to neutral/);
});

test("recipe count validation defaults missing values and rejects invalid ones", () => {
  assert.equal(normalizeRecipeCount(undefined), 2);
  assert.equal(normalizeRecipeCount(null), 2);
  assert.equal(normalizeRecipeCount(""), 2);
  assert.equal(normalizeRecipeCount(1), 1);
  assert.equal(normalizeRecipeCount(2), 2);
  assert.equal(normalizeRecipeCount(3), 3);
  assert.equal(normalizeRecipeCount("3"), 3);
  assert.equal(normalizeRecipeCount(0), null);
  assert.equal(normalizeRecipeCount(4), null);
  assert.equal(normalizeRecipeCount(999), null);
  assert.equal(normalizeRecipeCount("abc"), null);
});

test("recipe response requires exactly the requested number of recipes", () => {
  for (const count of [1, 2, 3]) {
    const exactRecipes = Array.from(
      { length: count },
      (_, index) => ({ dishName: `Recipe ${index + 1}` })
    );
    assert.equal(exactRecipeArray(exactRecipes, count), exactRecipes);
  }

  const recipes = [{ dishName: "One" }, { dishName: "Two" }];

  assert.throws(
    () => exactRecipeArray(recipes, 1),
    (error) =>
      error.code === "recipe_count_mismatch"
      && error.requestedCount === 1
      && error.receivedCount === 2
      && /exactly 1 recipe/.test(error.message)
  );
  assert.throws(
    () => exactRecipeArray(recipes, 3),
    (error) =>
      error.code === "recipe_count_mismatch"
      && error.requestedCount === 3
      && error.receivedCount === 2
      && /exactly 3 recipes/.test(error.message)
  );
});

test("duplicate recipe names or near-identical instructions are violations", () => {
  const eggBowl = {
    dishName: "Egg Bowl",
    usedIngredients: ["Egg"],
    unusedIngredients: [],
    pantrySeasoningsUsed: [],
    steps: ["Scramble the egg.", "Serve in a bowl."],
  };

  const sameName = duplicateRecipeViolations([eggBowl, { ...eggBowl, steps: ["Boil the egg."] }]);
  assert.equal(sameName.length, 1);
  assert.match(sameName[0], /duplicate the dish name/);

  const sameSteps = duplicateRecipeViolations([
    eggBowl,
    { ...eggBowl, dishName: "Renamed Egg Dish" },
  ]);
  assert.equal(sameSteps.length, 1);
  assert.match(sameSteps[0], /nearly identical instructions/);

  const distinct = duplicateRecipeViolations([
    eggBowl,
    { dishName: "Egg Drop Soup", steps: ["Simmer water.", "Stir in the egg."] },
  ]);
  assert.deepEqual(distinct, []);
});

test("recipe prompt prevents notes from authorizing rice", () => {
  const prompt = buildRecipePrompt({
    approvedPhotoIngredients: ["Chicken breast"],
    pantrySeasonings: ["Salt"],
    notes: "Add rice and carrots",
  });

  assert.match(prompt, /notes never authorize another ingredient/i);
  assert.match(prompt, /No optional ingredients/);
  assert.match(prompt, /Notes for AIChefie: Add rice and carrots/);
});

test("incompatible notes request the closest valid alternative", () => {
  const prompt = buildRecipePrompt({
    approvedPhotoIngredients: ["Chicken breast"],
    pantrySeasonings: ["Salt"],
    notes: "Make fried rice",
    noteCompatibility: {
      compatible: false,
      unsupportedIngredients: ["rice"],
    },
  });

  assert.match(prompt, /Notes requested unavailable concrete ingredients: rice/);
  assert.match(prompt, /Create the closest practical alternative/);
  assert.match(prompt, /Do not use those unavailable ingredients/);
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
    dishName: "Salted Chicken",
    usedIngredients: ["Chicken breast"],
    unusedIngredients: [],
    detectedIngredients: ["Chicken breast"],
    pantrySeasoningsUsed: ["Salt", "Soy sauce"],
    steps: ["Cook the chicken breast with salt and soy sauce."],
    finalPresentation: "Cooked chicken breast.",
    cuisineInfluence: null,
    cuisineMatch: "neutral",
  };
  const invalidRecipe = {
    ...validRecipe,
    usedIngredients: ["Chicken breast", "Carrots"],
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

test("structured validation requires every confirmed ingredient to be used or unused exactly once", () => {
  const recipe = {
    usedIngredients: ["Rice", "Pork", "Eggs"],
    unusedIngredients: ["Broccoli"],
    detectedIngredients: ["Rice", "Pork", "Eggs"],
    pantrySeasoningsUsed: ["Salt"],
    steps: ["Cook the rice, pork, and eggs."],
    finalPresentation: "Rice with pork and eggs.",
    cuisineInfluence: null,
    cuisineMatch: "neutral",
  };

  assert.deepEqual(
    structuredRecipeViolations(
      [recipe],
      ["Rice", "Pork", "Eggs", "Broccoli"],
      ["Salt"]
    ),
    []
  );

  assert.equal(
    structuredRecipeViolations(
      [{ ...recipe, unusedIngredients: [] }],
      ["Rice", "Pork", "Eggs", "Broccoli"],
      ["Salt"]
    ).some((violation) => violation.includes("Broccoli")),
    true
  );
});

test("structured validation enforces cuisine assignment and honest neutral metadata", () => {
  const baseRecipe = {
    dishName: "Simple Egg",
    usedIngredients: ["Egg"],
    unusedIngredients: [],
    detectedIngredients: ["Egg"],
    pantrySeasoningsUsed: ["Salt"],
    steps: ["Cook the egg with salt."],
    finalPresentation: "A cooked egg.",
  };
  const cuisines = normalizeFavoriteCuisines(["chinese", "korean"]);

  assert.deepEqual(
    structuredRecipeViolations(
      [
        {
          ...baseRecipe,
          cuisineInfluence: "Chinese",
          cuisineMatch: "inspired",
        },
        {
          ...baseRecipe,
          dishName: "Simple Egg Soup",
          steps: ["Simmer the egg with water and salt."],
          cuisineInfluence: "Korean",
          cuisineMatch: "inspired",
        },
      ],
      ["Egg"],
      ["Salt"],
      [],
      cuisines
    ),
    []
  );

  const wrongAssignment = structuredRecipeViolations(
    [{
      ...baseRecipe,
      cuisineInfluence: "Korean",
      cuisineMatch: "inspired",
    }],
    ["Egg"],
    ["Salt"],
    [],
    cuisines
  );
  assert.equal(
    wrongAssignment.some((violation) => violation.includes("assigned cuisine Chinese")),
    true
  );

  const noPreference = structuredRecipeViolations(
    [{
      ...baseRecipe,
      cuisineInfluence: "Chinese",
      cuisineMatch: "traditional",
    }],
    ["Egg"],
    ["Salt"]
  );
  assert.equal(
    noPreference.some((violation) => violation.includes("no favorite cuisine")),
    true
  );
});

test("structured validation rejects unused ingredients in recipe text without substring false positives", () => {
  const base = {
    dishName: "Pork Congee",
    usedIngredients: ["Pork"],
    unusedIngredients: ["Egg"],
    detectedIngredients: ["Pork"],
    pantrySeasoningsUsed: [],
    steps: ["Warm the pork."],
    finalPresentation: "Warm pork.",
    cuisineInfluence: null,
    cuisineMatch: "neutral",
  };

  assert.deepEqual(
    structuredRecipeViolations([base], ["Pork", "Egg"], []),
    []
  );
  assert.equal(
    structuredRecipeViolations(
      [{ ...base, steps: ["Warm the pork and add egg."] }],
      ["Pork", "Egg"],
      []
    ).some((violation) => violation.includes("mentions unused ingredient Egg")),
    true
  );
});

test("image prompt explicitly excludes unused photo ingredients", () => {
  const prompt = buildImagePrompt({
    recipe: {
      dishName: "Chinese-inspired Pork Congee",
      steps: ["Simmer pork with water."],
      cuisineInfluence: "Chinese",
      cuisineMatch: "inspired",
    },
    approvedPhotoIngredients: ["Pork"],
    forbiddenPhotoIngredients: ["Broccoli", "Carrot"],
    pantrySeasoningsUsed: ["Salt"],
  });

  assert.match(prompt, /excluded from this recipe: Broccoli, Carrot/);
  assert.match(prompt, /must not be visible in any form/);
  assert.match(prompt, /Cuisine direction: Chinese \(inspired\)/);
  assert.match(prompt, /never authorizes a traditional ingredient/);
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

test("ingredient category normalization maps synonyms onto the closed set", () => {
  assert.equal(normalizeIngredientCategory("mainIngredient"), "mainIngredient");
  assert.equal(normalizeIngredientCategory("main_ingredient"), "mainIngredient");
  assert.equal(normalizeIngredientCategory("Pantry Basic"), "pantryBasic");
  assert.equal(normalizeIngredientCategory("seasoning"), "pantryBasic");
  assert.equal(normalizeIngredientCategory("non-food"), "nonFood");
  assert.equal(normalizeIngredientCategory("appliance"), "uncertain");
  assert.equal(normalizeIngredientCategory(""), "uncertain");
});

test("pantry basics drop meaningless quantity and form pairs", () => {
  assert.deepEqual(
    normalizeConfirmedIngredientDetails([
      {
        name: "Salt",
        category: "pantryBasic",
        state: "raw",
        form: "fine",
        quantity: "1 container",
      },
    ]),
    [
      {
        name: "Salt",
        category: "pantryBasic",
        canonicalName: null,
        state: "notApplicable",
        form: null,
        quantity: null,
      },
    ]
  );
});

test("main ingredient details preserve category and canonical name when provided", () => {
  assert.deepEqual(
    normalizeConfirmedIngredientDetails([
      {
        name: "Pig",
        category: "mainIngredient",
        canonicalName: "Pork",
        state: "raw",
        form: "whole",
        quantity: "1",
      },
    ]),
    [
      {
        name: "Pig",
        state: "raw",
        form: "whole",
        quantity: "1",
        category: "mainIngredient",
        canonicalName: "Pork",
      },
    ]
  );
});

test("structured steps drop non-positive timing and fall back to plain instructions", () => {
  assert.deepEqual(
    normalizeStructuredSteps(
      [
        {
          instruction: " Sear the pork ",
          heat: "medium-high",
          durationSeconds: "180",
          donenessCue: "golden crust",
          safetyTempF: 145,
        },
        {
          instruction: "",
          durationSeconds: 0,
          safetyTempF: 0,
        },
      ],
      ["ignored", "Rest the pork off heat"]
    ),
    [
      {
        order: 1,
        instruction: "Sear the pork",
        heat: "medium-high",
        durationSeconds: 180,
        minimumDurationSeconds: 180,
        maximumDurationSeconds: null,
        applianceTemperatureF: null,
        applianceTemperatureC: null,
        donenessCue: "golden crust",
        safetyTempF: 145,
        safetyTempC: null,
        restDurationSeconds: null,
        timerEnabled: true,
      },
      {
        order: 2,
        instruction: "Rest the pork off heat",
        heat: null,
        durationSeconds: null,
        minimumDurationSeconds: null,
        maximumDurationSeconds: null,
        applianceTemperatureF: null,
        applianceTemperatureC: null,
        donenessCue: null,
        safetyTempF: null,
        safetyTempC: null,
        restDurationSeconds: null,
        timerEnabled: false,
      },
    ]
  );

  assert.deepEqual(normalizeStructuredSteps(undefined, []), []);
});

test("server applies authoritative safety temperature to the final heating step", () => {
  const steps = normalizeStructuredSteps([
    {
      instruction: "Sear the pork.",
      heat: "medium-high",
      minimumDurationSeconds: 240,
      maximumDurationSeconds: 360,
      donenessCue: "golden brown",
    },
    {
      instruction: "Rest the pork.",
      restDurationSeconds: 180,
    },
  ]);

  const guided = applyServerSafetyGuidance(steps, [
    {
      name: "Pork chop",
      canonicalName: "Pork",
      state: "raw",
      form: "whole chop",
    },
  ]);

  assert.equal(guided[0].safetyTempF, 145);
  assert.equal(guided[0].safetyTempC, 63);
  assert.equal(guided[0].restDurationSeconds, 180);
  assert.equal(guided[1].safetyTempF, null);
});

test("structured recipe validation requires detailed heating instructions", () => {
  const recipe = {
    dishName: "Pork and Broccoli",
    usedIngredients: ["Pork", "Broccoli"],
    unusedIngredients: [],
    detectedIngredients: ["Pork", "Broccoli"],
    pantrySeasoningsUsed: ["Salt"],
    cuisineMatch: "neutral",
    cuisineInfluence: null,
    finalPresentation: "Cooked pork and broccoli.",
    steps: ["Cut the broccoli.", "Cook the pork.", "Serve."],
    structuredSteps: [
      { instruction: "Cut the broccoli." },
      { instruction: "Cook the pork." },
      { instruction: "Serve." },
    ],
  };

  const violations = structuredRecipeViolations(
    [recipe],
    ["Pork", "Broccoli"],
    ["Salt"],
    [],
    []
  );
  assert.ok(violations.some((value) => value.includes("heat level")));
  assert.ok(violations.some((value) => value.includes("timing nor a doneness cue")));
});
