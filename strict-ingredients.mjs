export const ingredientConfidenceThreshold = 0.85;
export const ingredientSceneTypes = new Set([
  "prepared_ingredient",
  "cooked_food",
  "live_animal",
  "non_food",
  "unclear",
]);

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

    const rawState = cleanString(ingredient?.state).toLowerCase();
    const state = ["raw", "cooked"].includes(rawState) ? rawState : "unknown";
    seen.add(normalizedName);
    result.push({
      name,
      state,
      form: cleanString(ingredient?.form) || null,
      quantity: cleanString(ingredient?.quantity) || null,
    });
  }

  return result;
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

  return "Image hidden because CookLens could not verify that it matched the confirmed ingredients.";
}

export function structuredRecipeViolations(
  recipes,
  approvedPhotoIngredients,
  pantrySeasonings,
  confirmedIngredientDetails = []
) {
  const violations = [];

  for (const [index, recipe] of recipes.entries()) {
    for (const ingredient of normalizeStringArray(recipe.detectedIngredients)) {
      if (!approvedPhotoIngredients.some((approved) => sameName(approved, ingredient))) {
        violations.push(`Option ${index + 1} reports unapproved photo ingredient: ${ingredient}`);
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
}) {
  const allowedPhoto = approvedPhotoIngredients.join(", ");
  const allowedPantry = pantrySeasonings.length ? pantrySeasonings.join(", ") : "none";

  return [
    previousRecipes
      ? "Repair the two recipe options below so they obey every rule."
      : "Create exactly two immediately cookable recipe options.",
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
    "- detectedIngredients must contain only exact names from Photo ingredients.",
    "- pantrySeasoningsUsed must contain only exact names from Pantry seasonings.",
    "- pairingSuggestion is separate and may name one complementary food not in the whitelist. It must not appear anywhere else in the recipe.",
    "- Keep the recipes practical for home cooking.",
    "- Return compact JSON only.",
    "",
    `Notes for CookLens: ${notes || "none"}`,
    repairFeedback ? `Violations to repair: ${repairFeedback}` : "",
    previousRecipes ? `Recipes to repair: ${JSON.stringify(previousRecipes)}` : "",
    "",
    "JSON shape:",
    `{
  "recipes": [
    {
      "dishName": "string",
      "detectedIngredients": ["exact photo ingredient"],
      "pantrySeasoningsUsed": ["exact pantry seasoning"],
      "cookingTime": "string",
      "steps": ["string"],
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
    `Photo ingredients: ${approvedPhotoIngredients.join(", ")}`,
    `Confirmed ingredient details: ${JSON.stringify(confirmedIngredientDetails)}`,
    `Pantry seasonings incorporated into the food: ${pantrySeasoningsUsed.length ? pantrySeasoningsUsed.join(", ") : "none"}`,
    "",
    `Dish: ${recipe.dishName}`,
    `Cooking result: ${recipe.steps.join(" ")}`,
    `Required final presentation: ${finalPresentation || recipe.finalPresentation || "show the approved food in its confirmed form"}`,
    "",
    "STRICT COMPOSITION RULES:",
    "- Every visible food component must come from the closed whitelist above.",
    "- Show only the finished dish on one plain plate or in one plain bowl.",
    "- No vegetables, fruit, grains, rice, pasta, bread, potatoes, salad, herbs, garnish, side dishes, extra protein, or decorative sauce unless that exact item is in the whitelist.",
    "- Do not add visually common seasonings such as black pepper, peppercorns, chili flakes, parsley, chives, rosemary, or other herbs unless that exact item is in the whitelist.",
    "- When an approved protein names a specific cut or part, show only that cut or part. Do not show a whole animal, another cut, legs, wings, bones, or additional pieces from a different part.",
    "- Match the confirmed raw/cooked state and required final presentation. The image must show the finished cooked result, never packaging or the original uncooked scene.",
    "- Pantry seasonings may affect the cooked food, such as a glaze, but must not appear as separate decorative food.",
    "- Do not infer traditional accompaniments or restaurant plating.",
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
