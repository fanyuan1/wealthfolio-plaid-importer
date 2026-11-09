// Plaid personal_finance_category -> Wealthfolio spending/income category key.
export const SPENDING = "spending_categories";
export const INCOME = "income_sources";

// Detailed matches win over primary matches. Keys must exist in Wealthfolio;
// unknown subcategory keys fall back to their parent at push time.
export const DETAILED: Record<string, string> = {
  FOOD_AND_DRINK_GROCERIES: "groceries",
  FOOD_AND_DRINK_COFFEE: "food_coffee",
  FOOD_AND_DRINK_RESTAURANT: "food_restaurants",
  FOOD_AND_DRINK_FAST_FOOD: "food_restaurants",
  TRANSPORTATION_GAS: "transport_gas",
  TRANSPORTATION_TAXIS_AND_RIDE_SHARES: "transport_rideshare",
  RENT_AND_UTILITIES_RENT: "housing_rent",
  RENT_AND_UTILITIES_GAS_AND_ELECTRICITY: "housing_utilities",
  RENT_AND_UTILITIES_WATER: "housing_utilities",
  RENT_AND_UTILITIES_TELEPHONE: "bills_phone",
  RENT_AND_UTILITIES_INTERNET_AND_CABLE: "bills_internet",
  GENERAL_MERCHANDISE_ONLINE_MARKETPLACES: "shopping_online",
  ENTERTAINMENT_TV_AND_MOVIES: "entertainment_streaming",
  MEDICAL_PHARMACIES_AND_SUPPLEMENTS: "health_pharmacy",
  GENERAL_SERVICES_EDUCATION: "education",
  GOVERNMENT_AND_NON_PROFIT_DONATIONS: "gifts",
  INCOME_SALARY: "income_salary",
  INCOME_WAGES: "income_salary", // Plaid's older name for INCOME_SALARY
  INCOME_CONTRACTOR: "income_freelance",
  INCOME_DIVIDENDS: "income_dividends",
  INCOME_INTEREST_EARNED: "income_interest",
  INCOME_TAX_REFUND: "income_tax_refund",
};
export const PRIMARY: Record<string, string> = {
  FOOD_AND_DRINK: "food", GENERAL_MERCHANDISE: "shopping", HOME_IMPROVEMENT: "housing",
  RENT_AND_UTILITIES: "bills", MEDICAL: "health", PERSONAL_CARE: "personal",
  ENTERTAINMENT: "entertainment", TRAVEL: "travel", TRANSPORTATION: "transport",
  BANK_FEES: "fees", LOAN_PAYMENTS: "bills", GENERAL_SERVICES: "other_expense",
  GOVERNMENT_AND_NON_PROFIT: "other_expense", INCOME: "income_other",
};
const PRIMARIES = Object.keys(PRIMARY).sort((a, b) => b.length - a.length);

/** [taxonomyId, categoryKey], or null to leave uncategorized. */
export function mapCategory(pfc: string | null | undefined, inflow: boolean): [string, string] | null {
  if (!pfc) return null;
  const up = pfc.toUpperCase();
  let key: string | undefined = DETAILED[up];
  if (key === undefined) {
    const primary = PRIMARIES.find((p) => up === p || up.startsWith(p + "_"));
    key = primary ? PRIMARY[primary] : undefined;
  }
  if (key === undefined) key = inflow ? "income_other" : "other_expense";
  const taxonomy = key.startsWith("income_") ? INCOME : SPENDING;
  if (inflow && taxonomy === SPENDING) return null; // refunds etc.: leave for Wealthfolio rules
  return [taxonomy, key];
}
