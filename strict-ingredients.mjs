export const ingredientConfidenceThreshold = 0.85;
export const ingredientSceneTypes = new Set([
  "prepared_ingredient",
  "cooked_food",
  "live_animal",
  "non_food",
  "unclear",
]);
export const ingredientCategories = new Set([
  "mainIngredient",
  "pantryBasic",
  "nonFood",
  "uncertain",
]);

/// Maps the model's category label onto the closed set, tolerating snake_case,
/// spacing, and synonyms. Unknown labels fall back to "uncertain".
export function normalizeIngredientCategory(value) {
  const normalized = cleanString(value).toLowerCase().replace(/[\s_-]+/g, "");
  switch (normalized) {
    case "mainingredient":
    case "main":
    case "ingredient":
      return "mainIngredient";
    case "pantrybasic":
    case "pantry":
    case "seasoning":
    case "condiment":
    case "spice":
      return "pantryBasic";
    case "nonfood":
    case "object":
    case "tool":
      return "nonFood";
    default:
      return "uncertain";
  }
}

export function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];

  const seen = new Set();
  const result = [];

  for (const item of value) {
    const cleaned = cleanString(item);
    const normalized = normalizeName(cleaned);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(cleaned);
  }

  return result;
}

export function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeName(value) {
  return cleanString(value).replace(/\s+/g, " ").toLowerCase();
}

export function sameName(left, right) {
  return normalizeName(left) === normalizeName(right);
}

export function normalizeConfirmedIngredientDetails(value, fallbackNames = []) {
  const source = Array.isArray(value) && value.length
    ? value
    : normalizeStringArray(fallbackNames).map((name) => ({ name, state: "unknown" }));
  const seen = new Set();
  const result = [];

  for (const ingredient of source) {
    const name = cleanString(ingredient?.name);
    const normalizedName = normalizeName(name);
    if (!normalizedName || seen.has(normalizedName)) continue;
    seen.add(normalizedName);

    const hasCategory = ingredient?.category != null;
    const category = hasCategory
      ? normalizeIngredientCategory(ingredient.category)
      : null;

    // Pantry basics never carry a Raw/Cooked state, form, or quantity, so a pair
    // such as "salt — 1 container" is dropped to only the recognized name.
    if (category === "pantryBasic") {
      result.push({
        name,
        category,
        canonicalName: cleanString(ingredient?.canonicalName) || null,
        state: "notApplicable",
        form: null,
        quantity: null,
      });
      continue;
    }

    const rawState = cleanString(ingredient?.state).toLowerCase();
    const state = ["raw", "cooked"].includes(rawState) ? rawState : "unknown";
    const detail = {
      name,
      state,
      form: cleanString(ingredient?.form) || null,
      quantity: cleanString(ingredient?.quantity) || null,
    };
    // Only attach category metadata when the caller provided it, preserving the
    // older request shape for clients that do not send categories yet.
    if (category) {
      detail.category = category;
      detail.canonicalName = cleanString(ingredient?.canonicalName) || null;
    }
    result.push(detail);
  }

  return result;
}

/// Normalizes the model's structured cooking steps, pairing each with its plain
/// fallback instruction and dropping non-positive durations and temperatures.
export function normalizeStructuredSteps(value, fallbackSteps = []) {
  const source = Array.isArray(value) ? value : [];
  const result = [];

  source.forEach((step, index) => {
    const instruction =
      cleanString(step?.instruction)
      || (index < fallbackSteps.length ? cleanString(fallbackSteps[index]) : "");
    if (!instruction) return;

    const minimumDuration = Number(
      step?.minimumDurationSeconds ?? step?.durationSeconds
    );
    const maximumDuration = Number(step?.maximumDurationSeconds);
    const applianceTemperatureF = Number(step?.applianceTemperatureF);
    const applianceTemperatureC = Number(step?.applianceTemperatureC);
    const safety = Number(step?.safetyTempF);
    const safetyC = Number(step?.safetyTempC);
    const restDuration = Number(step?.restDurationSeconds);
    const normalizedMinimum =
      Number.isFinite(minimumDuration) && minimumDuration > 0
        ? Math.round(minimumDuration)
        : null;
    const normalizedMaximum =
      Number.isFinite(maximumDuration)
      && maximumDuration > 0
      && (!normalizedMinimum || maximumDuration >= normalizedMinimum)
        ? Math.round(maximumDuration)
        : null;
    result.push({
      order: result.length + 1,
      instruction,
      heat: cleanString(step?.heat) || null,
      durationSeconds: normalizedMinimum,
      minimumDurationSeconds: normalizedMinimum,
      maximumDurationSeconds: normalizedMaximum,
      applianceTemperatureF:
        Number.isFinite(applianceTemperatureF) && applianceTemperatureF > 0
          ? Math.round(applianceTemperatureF)
          : null,
      applianceTemperatureC:
        Number.isFinite(applianceTemperatureC) && applianceTemperatureC > 0
          ? Math.round(applianceTemperatureC)
          : null,
      donenessCue: cleanString(step?.donenessCue) || null,
      safetyTempF: Number.isFinite(safety) && safety > 0 ? Math.round(safety) : null,
      safetyTempC: Number.isFinite(safetyC) && safetyC > 0 ? Math.round(safetyC) : null,
      restDurationSeconds:
        Number.isFinite(restDuration) && restDuration > 0
          ? Math.round(restDuration)
          : null,
      timerEnabled: step?.timerEnabled !== false && normalizedMinimum !== null,
    });
  });

  return result.slice(0, 12);
}

export function safeMinimumTemperature(confirmedIngredientDetails = []) {
  const rawDetails = confirmedIngredientDetails.filter(
    (ingredient) => cleanString(ingredient?.state).toLowerCase() === "raw"
  );
  const searchable = rawDetails
    .map((ingredient) =>
      [
        ingredient?.canonicalName,
        ingredient?.name,
        ingredient?.form,
      ]
        .map(cleanString)
        .join(" ")
        .toLowerCase()
    )
    .join(" ");

  if (!searchable) return null;
  if (/\b(chicken|turkey|duck|goose|poultry)\b/.test(searchable)) {
    return { fahrenheit: 165, celsius: 74, restDurationSeconds: null };
  }
  if (/\b(ground|minced)\b/.test(searchable) && /\b(beef|pork|lamb|veal|meat)\b/.test(searchable)) {
    return { fahrenheit: 160, celsius: 71, restDurationSeconds: null };
  }
  if (/\b(egg|eggs)\b/.test(searchable)) {
    return { fahrenheit: 160, celsius: 71, restDurationSeconds: null };
  }
  if (/\b(fish|salmon|tuna|cod|tilapia|trout|halibut|shrimp|prawn|lobster|crab|seafood)\b/.test(searchable)) {
    return { fahrenheit: 145, celsius: 63, restDurationSeconds: null };
  }
  if (/\b(beef|pork|lamb|veal|steak|chop|roast)\b/.test(searchable)) {
    return { fahrenheit: 145, celsius: 63, restDurationSeconds: 180 };
  }
  return null;
}

export function applyServerSafetyGuidance(steps, confirmedIngredientDetails = []) {
  const safety = safeMinimumTemperature(confirmedIngredientDetails);
  if (!safety || !steps.length) return steps;

  let targetIndex = -1;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index];
    if (
      step.heat
      || step.applianceTemperatureF
      || step.applianceTemperatureC
      || step.minimumDurationSeconds
    ) {
      targetIndex = index;
      break;
    }
  }
  if (targetIndex < 0) return steps;

  return steps.map((step, index) =>
    index === targetIndex
      ? {
          ...step,
          safetyTempF: safety.fahrenheit,
          safetyTempC: safety.celsius,
          restDurationSeconds:
            step.restDurationSeconds ?? safety.restDurationSeconds,
        }
      : {
          ...step,
          // Safety data is authoritative and belongs on the final cooking step.
          safetyTempF: null,
          safetyTempC: null,
        }
  );
}

export function buildNoteCompatibilityPrompt({
  approvedPhotoIngredients,
  pantrySeasonings,
  notes,
}) {
  return [
    "Decide whether the user's cooking request can be fulfilled using only the closed ingredient whitelist.",
    `Confirmed photo ingredients: ${approvedPhotoIngredients.join(", ")}`,
    `Pantry seasonings: ${pantrySeasonings.length ? pantrySeasonings.join(", ") : "none"}`,
    `User notes: ${notes}`,
    "",
    "RULES:",
    "- Cooking styles and dish formats are not ingredients. Words such as salad, soup, bowl, roasted, grilled, stir-fry, braised, glazed, spicy, crispy, and simple are allowed when the confirmed ingredients can reasonably be prepared that way.",
    "- A request conflicts only when it requires a concrete food ingredient that is not in the whitelist, or when the requested dish format is impossible with the confirmed ingredients.",
    "- Example: lettuce and carrot with 'make salad' is compatible.",
    "- Example: goose with 'make salad' is incompatible because salad requires plant ingredients that are not confirmed.",
    "- Do not treat water, heat, cooking actions, textures, or flavor intensity as ingredients.",
    "- Return compact JSON only.",
    "",
    `{
  "compatible": true,
  "requestedStyle": "short cooking style or null",
  "unsupportedIngredients": ["specific missing food"],
  "reason": "short user-facing explanation"
}`,
  ].join("\n");
}

export function normalizeNoteCompatibility(value) {
  const unsupportedIngredients = normalizeStringArray(value?.unsupportedIngredients);
  return {
    compatible: value?.compatible === true && unsupportedIngredients.length === 0,
    requestedStyle: cleanString(value?.requestedStyle) || null,
    unsupportedIngredients,
    reason: cleanString(value?.reason),
  };
}

export function normalizeRecipeAudit(value) {
  const violations = Array.isArray(value?.violations)
    ? value.violations
      .map((violation) => ({
        optionIndex: Number.isInteger(violation?.optionIndex) ? violation.optionIndex : null,
        ingredient: cleanString(violation?.ingredient),
        evidence: cleanString(violation?.evidence),
      }))
      .filter((violation) => violation.ingredient && violation.evidence)
    : [];

  return {
    valid: violations.length === 0,
    violations,
    reason: cleanString(value?.reason)
      || (violations.length === 0
        ? "Recipe follows the whitelist."
        : violations.map((violation) => `${violation.ingredient}: ${violation.evidence}`).join("; ")),
  };
}

export function normalizeIngredientScene(value, detectedIngredients = []) {
  const requestedType = cleanString(value?.sceneType).toLowerCase();
  const sceneType = ingredientSceneTypes.has(requestedType)
    ? requestedType
    : detectedIngredients.length
      ? "prepared_ingredient"
      : "unclear";
  const numericConfidence = Number(value?.sceneConfidence);
  const sceneConfidence = Number.isFinite(numericConfidence)
    ? Math.min(1, Math.max(0, numericConfidence))
    : 0;

  return {
    sceneType,
    sceneConfidence,
    sceneReason: cleanString(value?.sceneReason) || null,
  };
}

export function normalizeImageReview(value, model = null) {
  const visibleFoodItems = normalizeStringArray(value?.visibleFoodItems);
  const unapprovedFoodItems = normalizeStringArray(value?.unapprovedFoodItems);
  const presentationIssues = normalizeStringArray(value?.presentationIssues);
  const evidenceCount = unapprovedFoodItems.length + presentationIssues.length;
  const requestedDecision = cleanString(value?.decision).toLowerCase();
  let decision;

  if (evidenceCount > 0) {
    decision = "fail";
  } else if (requestedDecision === "pass" || value?.valid === true) {
    decision = "pass";
  } else {
    decision = "uncertain";
  }

  const numericConfidence = Number(value?.confidence);
  const confidence = Number.isFinite(numericConfidence)
    ? Math.min(1, Math.max(0, numericConfidence))
    : null;

  return {
    decision,
    confidence,
    visibleFoodItems,
    unapprovedFoodItems,
    presentationIssues,
    reason: cleanString(value?.reason) || null,
    model,
    valid: decision === "pass",
  };
}

export function combineImageReviews(primaryReview, secondOpinion) {
  if (primaryReview.decision !== "uncertain") {
    return {
      ...primaryReview,
      secondOpinionUsed: false,
      secondOpinion: null,
    };
  }

  const secondHasConcreteEvidence =
    secondOpinion.unapprovedFoodItems.length > 0
    || secondOpinion.presentationIssues.length > 0;
  const decision = secondOpinion.decision === "fail" && secondHasConcreteEvidence
    ? "fail"
    : "pass";

  return {
    ...secondOpinion,
    decision,
    valid: decision === "pass",
    reason:
      secondOpinion.reason
      || (decision === "pass"
        ? "A second reviewer found no concrete visible violation."
        : primaryReview.reason),
    secondOpinionUsed: true,
    secondOpinion,
    primaryReview,
  };
}

export function imageValidationFailureMessage(validation) {
  const unapprovedFoodItems = normalizeStringArray(validation?.unapprovedFoodItems);
  if (unapprovedFoodItems.length) {
    return `Image hidden because it visibly included unapproved food: ${unapprovedFoodItems.join(", ")}.`;
  }

  const presentationIssues = normalizeStringArray(validation?.presentationIssues);
  if (presentationIssues.length) {
    return `Image hidden because the presentation did not match the confirmed ingredient: ${presentationIssues.join("; ")}.`;
  }

  return "Image hidden because AIChefie could not verify that it matched the confirmed ingredients.";
}

// Mirrors the iOS CuisineCatalog. Only these IDs may influence recipe style.
export const cuisineCatalog = Object.freeze({
  "american": "American",
  "caribbean": "Caribbean",
  "chinese": "Chinese",
  "french": "French",
  "indian": "Indian",
  "italian": "Italian",
  "japanese": "Japanese",
  "korean": "Korean",
  "mediterranean": "Mediterranean",
  "mexican": "Mexican",
  "middle-eastern": "Middle Eastern",
  "thai": "Thai",
  "vietnamese": "Vietnamese",
  "west-african": "West African",
});

export const cuisineMatchTypes = new Set([
  "traditional",
  "inspired",
  "neutral",
]);

/// Drops unknown IDs and duplicates; returns [{ id, displayName }] in the
/// order the user sent them. Never throws: cuisine preferences are an
/// optional style hint, not a hard requirement.
export function normalizeFavoriteCuisines(value) {
  if (!Array.isArray(value)) return [];

  const seen = new Set();
  const result = [];
  for (const raw of value) {
    const id = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!cuisineCatalog[id] || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, displayName: cuisineCatalog[id] });
  }
  return result;
}

export function buildCuisineAssignmentPlan(recipeCount, favoriteCuisines) {
  if (!favoriteCuisines.length) {
    return Array.from({ length: recipeCount }, (_, index) => ({
      optionIndex: index + 1,
      cuisineID: null,
      displayName: null,
    }));
  }

  return Array.from({ length: recipeCount }, (_, index) => {
    const cuisine = favoriteCuisines[index % favoriteCuisines.length];
    return {
      optionIndex: index + 1,
      cuisineID: cuisine.id,
      displayName: cuisine.displayName,
    };
  });
}

function containsNormalizedPhrase(text, phrase) {
  const normalizedText = normalizeName(text);
  const normalizedPhrase = normalizeName(phrase);
  if (!normalizedText || !normalizedPhrase) return false;

  const escapedPhrase = normalizedPhrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escapedPhrase.replace(/\s+/g, "\\s+")}([^a-z0-9]|$)`)
    .test(normalizedText);
}

/// Missing values fall back to 2 for older app versions; explicitly invalid
/// values return null so the caller can reject the request.
export function normalizeRecipeCount(value) {
  if (value === undefined || value === null || value === "") {
    return 2;
  }

  const count = Number(value);
  return [1, 2, 3].includes(count) ? count : null;
}

export function exactRecipeArray(value, recipeCount) {
  const recipes = Array.isArray(value) ? value : [];
  if (recipes.length !== recipeCount) {
    const error = new Error(
      `Recipe response must contain exactly ${recipeCount} recipe${recipeCount === 1 ? "" : "s"}`
    );
    error.code = "recipe_count_mismatch";
    error.requestedCount = recipeCount;
    error.receivedCount = recipes.length;
    throw error;
  }
  return recipes;
}

export function duplicateRecipeViolations(recipes) {
  const violations = [];
  const normalizedSteps = (recipe) =>
    normalizeStringArray(recipe.steps).join(" ").toLowerCase().replace(/\s+/g, " ");

  for (let first = 0; first < recipes.length; first += 1) {
    for (let second = first + 1; second < recipes.length; second += 1) {
      if (sameName(recipes[first].dishName, recipes[second].dishName)) {
        violations.push(
          `Options ${first + 1} and ${second + 1} duplicate the dish name "${recipes[first].dishName}"; every option must be a meaningfully different recipe`
        );
      } else if (
        normalizedSteps(recipes[first])
        && normalizedSteps(recipes[first]) === normalizedSteps(recipes[second])
      ) {
        violations.push(
          `Options ${first + 1} and ${second + 1} share nearly identical instructions; options must differ in cooking method, texture, dish format, flavor treatment, or preparation style`
        );
      }
    }
  }

  return violations;
}

export function structuredRecipeViolations(
  recipes,
  approvedPhotoIngredients,
  pantrySeasonings,
  confirmedIngredientDetails = [],
  favoriteCuisines = []
) {
  const violations = [...duplicateRecipeViolations(recipes)];
  const allowedCuisineNames = new Set(
    favoriteCuisines.map((cuisine) => normalizeName(cuisine.displayName))
  );
  const cuisinePlan = buildCuisineAssignmentPlan(recipes.length, favoriteCuisines);

  for (const [index, recipe] of recipes.entries()) {
    const usedIngredients = normalizeStringArray(
      recipe.usedIngredients ?? recipe.detectedIngredients
    );
    const unusedIngredients = normalizeStringArray(recipe.unusedIngredients);

    for (const ingredient of [...usedIngredients, ...unusedIngredients]) {
      if (!approvedPhotoIngredients.some((approved) => sameName(approved, ingredient))) {
        violations.push(`Option ${index + 1} reports unapproved photo ingredient: ${ingredient}`);
      }
    }

    for (const approved of approvedPhotoIngredients) {
      const usedCount = usedIngredients.filter((ingredient) =>
        sameName(approved, ingredient)
      ).length;
      const unusedCount = unusedIngredients.filter((ingredient) =>
        sameName(approved, ingredient)
      ).length;
      if (usedCount + unusedCount !== 1) {
        violations.push(
          `Option ${index + 1} must place ${approved} in exactly one of usedIngredients or unusedIngredients`
        );
      }
    }

    if (usedIngredients.length === 0) {
      violations.push(`Option ${index + 1} must use at least one confirmed photo ingredient`);
    }

    const detectedIngredients = normalizeStringArray(recipe.detectedIngredients);
    if (
      detectedIngredients.length !== usedIngredients.length
      || detectedIngredients.some((ingredient) =>
        !usedIngredients.some((used) => sameName(used, ingredient))
      )
    ) {
      violations.push(
        `Option ${index + 1} detectedIngredients must exactly match usedIngredients`
      );
    }

    const recipeText = [
      recipe.dishName,
      recipe.finalPresentation,
      ...normalizeStringArray(recipe.steps),
    ]
      .map(cleanString)
      .join(" ");
    for (const ingredient of unusedIngredients) {
      if (containsNormalizedPhrase(recipeText, ingredient)) {
        violations.push(
          `Option ${index + 1} mentions unused ingredient ${ingredient} in its name, instructions, or final presentation`
        );
      }
    }

    for (const seasoning of normalizeStringArray(recipe.pantrySeasoningsUsed)) {
      if (!pantrySeasonings.some((approved) => sameName(approved, seasoning))) {
        violations.push(`Option ${index + 1} reports unapproved pantry item: ${seasoning}`);
      }
    }

    if (confirmedIngredientDetails.length && !cleanString(recipe.finalPresentation)) {
      violations.push(`Option ${index + 1} is missing a finalPresentation description`);
    }

    if (recipe.structuredSteps !== undefined) {
      const structuredSteps = normalizeStructuredSteps(
        recipe.structuredSteps,
        normalizeStringArray(recipe.steps)
      );
      if (structuredSteps.length < 2 || structuredSteps.length > 8) {
        violations.push(`Option ${index + 1} must contain 2 to 8 structured cooking steps`);
      }
      const heatingPattern = /\b(heat|cook|sear|simmer|boil|bake|roast|fry|saute|steam|grill|broil|reheat|warm)\b/i;
      for (const step of structuredSteps) {
        if (!heatingPattern.test(step.instruction)) continue;
        if (!step.heat && !step.applianceTemperatureF && !step.applianceTemperatureC) {
          violations.push(
            `Option ${index + 1}, step ${step.order} applies heat but does not specify a heat level or appliance temperature`
          );
        }
        if (!step.minimumDurationSeconds && !step.donenessCue) {
          violations.push(
            `Option ${index + 1}, step ${step.order} applies heat but provides neither timing nor a doneness cue`
          );
        }
      }
    }

    const cuisineInfluence = cleanString(recipe.cuisineInfluence);
    const cuisineMatch = cleanString(recipe.cuisineMatch).toLowerCase();
    if (!cuisineMatchTypes.has(cuisineMatch)) {
      violations.push(
        `Option ${index + 1} cuisineMatch must be traditional, inspired, or neutral`
      );
    } else if (cuisineMatch === "neutral") {
      if (cuisineInfluence) {
        violations.push(
          `Option ${index + 1} must not name a cuisineInfluence when cuisineMatch is neutral`
        );
      }
    } else {
      if (!cuisineInfluence) {
        violations.push(
          `Option ${index + 1} must name a cuisineInfluence for a ${cuisineMatch} recipe`
        );
      } else if (!allowedCuisineNames.has(normalizeName(cuisineInfluence))) {
        violations.push(
          `Option ${index + 1} uses cuisine influence ${cuisineInfluence}, which was not selected by the user`
        );
      } else {
        const assignedCuisine = cuisinePlan[index]?.displayName;
        if (
          assignedCuisine
          && normalizeName(cuisineInfluence) !== normalizeName(assignedCuisine)
        ) {
          violations.push(
            `Option ${index + 1} must follow its assigned cuisine ${assignedCuisine} or use neutral metadata`
          );
        }
      }
    }

    if (!favoriteCuisines.length && cuisineMatch !== "neutral") {
      violations.push(
        `Option ${index + 1} must use neutral cuisine metadata when no favorite cuisine was selected`
      );
    }
  }

  return violations;
}

export function buildRecipePrompt({
  approvedPhotoIngredients,
  pantrySeasonings,
  notes,
  confirmedIngredientDetails = [],
  previousRecipes,
  repairFeedback,
  recipeCount = 2,
  favoriteCuisines = [],
  noteCompatibility = null,
}) {
  const allowedPhoto = approvedPhotoIngredients.join(", ");
  const allowedPantry = pantrySeasonings.length ? pantrySeasonings.join(", ") : "none";
  const countWord = { 1: "one", 2: "two", 3: "three" }[recipeCount] || "two";
  const optionNoun = recipeCount === 1 ? "recipe option" : "recipe options";
  const cuisinePlan = buildCuisineAssignmentPlan(recipeCount, favoriteCuisines);

  return [
    previousRecipes
      ? `Repair the ${countWord} ${optionNoun} below so they obey every rule.`
      : `Create exactly ${countWord} ${recipeCount > 1 ? "distinct, " : ""}immediately cookable ${optionNoun}.`,
    `Return one JSON object containing a "recipes" array with exactly ${recipeCount} ${recipeCount === 1 ? "entry" : "entries"}.`,
    "Do not return introductory text, Markdown, code fences, or commentary.",
    recipeCount > 1
      ? "Each option must differ meaningfully in at least one of: cooking method, texture, dish format, flavor treatment, or preparation style. Renaming a dish does not make it different."
      : "",
    "",
    "CLOSED INGREDIENT WHITELIST:",
    `Photo ingredients: ${allowedPhoto}`,
    `Confirmed ingredient details: ${JSON.stringify(confirmedIngredientDetails)}`,
    `Pantry seasonings: ${allowedPantry}`,
    "",
    "NON-NEGOTIABLE RULES:",
    "- The whitelist is closed. Use only the photo ingredients and pantry seasonings listed above.",
    "- Never add, assume, imply, or recommend another ingredient inside the dish name, ingredient arrays, or cooking steps.",
    "- No optional ingredients. No substitutions. No sides. No garnish. No serving instructions that introduce another food.",
    "- Pantry items may be used only when they appear in the Pantry seasonings list.",
    "- Notes may change cooking method, flavor intensity, texture, or simplicity, but notes never authorize another ingredient.",
    "- Words that describe a cooking style or dish format, including salad, soup, bowl, roasted, grilled, stir-fry, braised, glazed, spicy, and crispy, are not ingredients.",
    "- Honor a compatible dish style from Notes using only the whitelist. For example, confirmed vegetables may become a salad without adding other foods.",
    "- Water and heat are allowed cooking utilities. Do not report water as a detected ingredient.",
    "- Respect each ingredient's confirmed state, form, and quantity.",
    "- Raw ingredients must receive realistic food-safe cooking instructions appropriate to that ingredient.",
    "- Cooked ingredients are already cooked. Do not instruct the user to cook them from raw; use reheating, warming, crisping, glazing, slicing, or serving steps as appropriate.",
    "- Do not change a confirmed form into a visibly different form. A tail, fillet, breast, sliced item, or whole item must remain that form unless a step explicitly cuts that same item.",
    "- finalPresentation must briefly describe exactly what the finished approved food should visibly look like. It may not introduce another food.",
    "- Divide every Photo ingredient into exactly one array: usedIngredients or unusedIngredients.",
    "- usedIngredients contains only ingredients actually used by this recipe.",
    "- unusedIngredients contains every remaining confirmed Photo ingredient that this recipe leaves out.",
    "- Do not mention unusedIngredients in the dish name, cooking steps, or finalPresentation.",
    "- detectedIngredients is a compatibility alias and must exactly match usedIngredients.",
    "- pantrySeasoningsUsed must contain only exact names from Pantry seasonings.",
    "- pairingSuggestion is separate and may name one complementary food not in the whitelist. It must not appear anywhere else in the recipe.",
    "- Keep the recipes practical for home cooking.",
    "- Return compact JSON only.",
    favoriteCuisines.length
      ? [
          "",
          "FAVORITE CUISINES:",
          `The user's favorite cuisines: ${favoriteCuisines.map((cuisine) => cuisine.displayName).join(", ")}.`,
          `Cuisine assignment plan: ${JSON.stringify(cuisinePlan)}.`,
          "Follow the assignment plan in option order whenever that cuisine can be represented honestly.",
          "When multiple cuisines are selected, distribute options according to the plan instead of blending them together.",
          "Do not create fusion food unless the user explicitly asks for fusion in Notes.",
          "Cuisine preference changes style only. It never authorizes an ingredient outside the whitelist.",
          "Use cuisineMatch='traditional' only when the defining ingredients and technique are supported by the whitelist.",
          "If a traditional dish is not honestly possible, use cuisineMatch='inspired' and a truthful '<Cuisine>-inspired' name.",
          "If even an inspired result would be misleading, use cuisineMatch='neutral', set cuisineInfluence to null, and create a practical neutral recipe.",
        ]
          .filter(Boolean)
          .join("\n")
      : "",
    !favoriteCuisines.length
      ? [
          "",
          "CUISINE DIRECTION:",
          "No favorite cuisine was selected.",
          "Generate a balanced practical variety.",
          "Set cuisineInfluence to null and cuisineMatch to neutral for every option.",
        ].join("\n")
      : "",
    "",
    `Notes for AIChefie: ${notes || "none"}`,
    noteCompatibility?.compatible === false
      ? [
          `Notes requested unavailable concrete ingredients: ${normalizeStringArray(noteCompatibility.unsupportedIngredients).join(", ") || "unspecified"}.`,
          "Do not use those unavailable ingredients.",
          "Create the closest practical alternative that follows the requested method or intent without claiming the unavailable food is present.",
        ].join("\n")
      : "",
    repairFeedback ? `Violations to repair: ${repairFeedback}` : "",
    previousRecipes ? `Recipes to repair: ${JSON.stringify(previousRecipes)}` : "",
    "",
    "STRUCTURED STEPS:",
    "- Provide structuredSteps as the authoritative instructions, one entry per step in cooking order.",
    "- Each structuredSteps.instruction must be a complete, self-contained sentence that also reads correctly on its own.",
    "- Return 2 to 8 structured steps. Simple dishes may use two complete steps; do not pad them with meaningless actions or combine preparation, cooking, and resting into one vague step.",
    "- Set heat to low, medium-low, medium, medium-high, or high whenever a burner is used. Use null when no burner heat is applied.",
    "- For an oven, air fryer, or similar appliance, set applianceTemperatureF and applianceTemperatureC. Do not place oven temperature text in heat.",
    "- Set minimumDurationSeconds to the shortest expected duration. Set maximumDurationSeconds when the user should check within a range. Use null for an untimed step.",
    "- Set timerEnabled true when minimumDurationSeconds is present and the action can be timed.",
    "- Set donenessCue to a short visible, textural, or aromatic sign the step is complete, such as 'golden and crisp'. Use null when not applicable.",
    "- Set restDurationSeconds when resting is part of the method.",
    "- Set safetyTempF and safetyTempC to null. The server attaches authoritative food-safety temperatures after generation.",
    "- Every step that applies heat must include a heat level or appliance temperature, plus timing or a concrete doneness cue.",
    "- steps must contain the same instruction strings as structuredSteps in the same order, for backward compatibility.",
    "",
    "JSON shape:",
    `{
  "recipes": [
    {
      "dishName": "string",
      "usedIngredients": ["exact photo ingredient actually used"],
      "unusedIngredients": ["exact confirmed photo ingredient intentionally left out"],
      "detectedIngredients": ["same values as usedIngredients"],
      "pantrySeasoningsUsed": ["exact pantry seasoning"],
      "cuisineInfluence": "selected cuisine display name or null",
      "cuisineMatch": "traditional | inspired | neutral",
      "cookingTime": "string",
      "steps": ["same instruction strings as structuredSteps"],
      "structuredSteps": [
        {
          "instruction": "complete sentence",
          "heat": "heat level or null",
          "minimumDurationSeconds": 0,
          "maximumDurationSeconds": 0,
          "applianceTemperatureF": 0,
          "applianceTemperatureC": 0,
          "donenessCue": "short doneness sign or null",
          "safetyTempF": null,
          "safetyTempC": null,
          "restDurationSeconds": 0,
          "timerEnabled": true
        }
      ],
      "finalPresentation": "short visible result using only approved food",
      "pairingSuggestion": "optional short string or null"
    }
  ]
}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildImagePrompt({
  recipe,
  approvedPhotoIngredients,
  forbiddenPhotoIngredients = [],
  pantrySeasoningsUsed,
  confirmedIngredientDetails = [],
  finalPresentation,
  retryViolations = [],
}) {
  const violationText = retryViolations.length
    ? `The previous image was rejected for showing: ${retryViolations.join(", ")}. Do not show these items.`
    : "";

  return [
    "Generate one realistic finished food photograph for a mobile recipe card.",
    "",
    "CLOSED VISIBLE FOOD WHITELIST:",
    `Ingredients used by this recipe: ${approvedPhotoIngredients.join(", ")}`,
    `Confirmed photo ingredients excluded from this recipe: ${forbiddenPhotoIngredients.length ? forbiddenPhotoIngredients.join(", ") : "none"}`,
    `Confirmed ingredient details: ${JSON.stringify(confirmedIngredientDetails)}`,
    `Pantry seasonings incorporated into the food: ${pantrySeasoningsUsed.length ? pantrySeasoningsUsed.join(", ") : "none"}`,
    "",
    `Dish: ${recipe.dishName}`,
    `Cuisine direction: ${recipe.cuisineMatch === "neutral" || !recipe.cuisineInfluence ? "neutral" : `${recipe.cuisineInfluence} (${recipe.cuisineMatch})`}`,
    `Cooking result: ${recipe.steps.join(" ")}`,
    `Required final presentation: ${finalPresentation || recipe.finalPresentation || "show the approved food in its confirmed form"}`,
    "",
    "STRICT COMPOSITION RULES:",
    "- Every visible food component must come from the closed whitelist above.",
    "- Ingredients listed as excluded from this recipe must not be visible in any form.",
    "- Show only the finished dish on one plain plate or in one plain bowl.",
    "- No vegetables, fruit, grains, rice, pasta, bread, potatoes, salad, herbs, garnish, side dishes, extra protein, or decorative sauce unless that exact item is in the whitelist.",
    "- Do not add visually common seasonings such as black pepper, peppercorns, chili flakes, parsley, chives, rosemary, or other herbs unless that exact item is in the whitelist.",
    "- When an approved protein names a specific cut or part, show only that cut or part. Do not show a whole animal, another cut, legs, wings, bones, or additional pieces from a different part.",
    "- Match the confirmed raw/cooked state and required final presentation. The image must show the finished cooked result, never packaging or the original uncooked scene.",
    "- Pantry seasonings may affect the cooked food, such as a glaze, but must not appear as separate decorative food.",
    "- Do not infer traditional accompaniments or restaurant plating.",
    "- Cuisine direction affects photographic styling only. It never authorizes a traditional ingredient, garnish, side, or table setting.",
    "- No background food, second plate, beverage, packaging, labels, text, hands, or utensils.",
    "- Use a neutral uncluttered background and natural light.",
    "- A correction warning from a previous rejected image is absolute and overrides normal food styling.",
    violationText,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function generateValidatedImage({
  generateImage,
  validateImage,
  maxAttempts = 2,
}) {
  let retryViolations = [];
  const records = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const generated = await generateImage(retryViolations, attempt);
    const imageDataURL = typeof generated === "string"
      ? generated
      : generated?.imageDataURL;
    const metadata = typeof generated === "string"
      ? {}
      : generated?.metadata || {};

    if (!imageDataURL) {
      throw new Error("Image generation did not return image data");
    }

    const validation = await validateImage(imageDataURL);
    const visibleFoodItems = normalizeStringArray(validation.visibleFoodItems);
    const unapprovedFoodItems = normalizeStringArray(validation.unapprovedFoodItems);
    const presentationIssues = normalizeStringArray(validation.presentationIssues);
    const validationIssues = [...unapprovedFoodItems, ...presentationIssues];
    const record = {
      attempt,
      ...metadata,
      valid: validation.valid === true,
      reviewDecision: cleanString(validation.decision) || (validation.valid ? "pass" : "fail"),
      reviewConfidence:
        Number.isFinite(validation.confidence) ? validation.confidence : null,
      reviewModel: cleanString(validation.model) || null,
      secondOpinionModel: cleanString(validation.secondOpinion?.model) || null,
      secondOpinionUsed: validation.secondOpinionUsed === true,
      reviewReason: cleanString(validation.reason) || null,
      visibleFoodItems,
      unapprovedFoodItems,
      presentationIssues,
    };
    records.push(record);

    if (validation.valid && validationIssues.length === 0) {
      return {
        imageDataURL,
        imageError: null,
        attempts: attempt,
        records,
      };
    }

    retryViolations = validationIssues.length
      ? validationIssues
      : ["unapproved food, garnish, or incorrect ingredient presentation"];
  }

  return {
    imageDataURL: null,
    imageError: imageValidationFailureMessage(records.at(-1)),
    attempts: maxAttempts,
    records,
  };
}

export function extractImageDataURL(response) {
  const message = response?.choices?.[0]?.message || response?.choices?.[0]?.delta || {};
  const candidates = [
    ...(Array.isArray(message.images) ? message.images : []),
    ...(Array.isArray(message.content) ? message.content : []),
    ...(Array.isArray(response?.data) ? response.data : []),
    response?.output_image,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const directURL = firstString(
      candidate?.image_url?.url,
      candidate?.imageUrl?.url,
      candidate?.image_url,
      candidate?.imageUrl,
      candidate?.url,
      candidate?.source?.url
    );
    if (directURL?.startsWith("data:image/")) {
      return directURL;
    }

    const base64 = firstString(
      candidate?.b64_json,
      candidate?.base64,
      candidate?.source?.data
    );
    if (base64) {
      const mimeType = firstString(
        candidate?.mime_type,
        candidate?.mimeType,
        candidate?.source?.media_type,
        candidate?.source?.mediaType
      ) || "image/png";
      return `data:${mimeType};base64,${base64}`;
    }
  }

  return null;
}

export function openRouterUsageCost(response) {
  const cost = Number(response?.usage?.cost);
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.length > 0) || null;
}
