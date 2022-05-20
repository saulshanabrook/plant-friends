//
//  ModelData.swift
//  plant-friends
//
//  Created by Saul Shanabrook on 5/2/22.
//

import Foundation

struct Image: Hashable, Decodable, Identifiable {
    var url: String
    var source: String
    var id: String {
        return self.url
    }
    
    var parsedURL: URL? {
        guard let escapedString = self.url.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)
        else { return nil }
        // Escape spaces from URL before parses
        return URL(string: escapedString)
    }
}

struct Use: Hashable, Decodable, Identifiable {
    var category: String?
    var name: String?
    var id: String {
        return String(describing: (self.category, self.name))
    }
}

struct Uses: Hashable, Decodable, Identifiable {
    var name: String?
    var uses: [String]
    var id: String  {
        return self.name ?? "undefined"
    }
}

struct Field: Hashable, Decodable, Identifiable {
    let id: String
    let text: String
    let uses: [Uses]
    
    init(_ id: String, _ text: String, uses: [Uses]) {
        self.id = id
        self.text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        self.uses =  uses.filter({uses in !uses.uses.isEmpty})
    }
    init(_ id: String, _ text: String) {
        self.init(id, text, uses: [])
    }
    init(_ id: String, _ text: String, _ singleUses: [String]) {
        self.init(id, text, uses: [Uses(name: nil, uses: singleUses)])
    }
    
}



struct PFAFPlant: Hashable, Decodable, Identifiable {
    var latin_name: String
    var habit: String
    var height: Double
    var hardiness: String
    var growth: String
    var soil: String
    var shade: String
    var moisture: String
    var edibility_rating: Double?
    var medicinal_rating: Double?
    var other_uses_rating: Double?
    var family: String
    var known_hazards: String
    var habitats: String
    var range: String
    var weed_potential: String
    var summary: String
    var physical_characteristics: String
    var synonyms: String
    var habitats_section: String
    var edible_uses: String
    var medicinal_uses: String
    var other_uses: String
    var cultivation_details: String
    var propagation: String
    var other_names: String
    var found_in: String
    var weed_potential_section: String
    var conservation_status: String
    var expert_comment: String
    var author: String
    var botanical_references: String
    
    var common_names: [String?]
    var images: [Image]
    var uses: [Use]
    
    var id: String {
        return self.latin_name
    }
    
    var common_names_not_nil: [String] {
        return self.common_names.compactMap({$0})
    }
    
    var common_names_joined: String {
        return self.common_names_not_nil.joined(separator: ", ")
    }
    
    var tableFields: [Field] {
        let fields =  [
            Field("Habit", self.habit),
            Field("Height", String(self.height)),
            Field("Hardiness", self.hardiness),
            Field("Growth", self.growth),
            Field("Soil", self.soil),
            Field("Shade", self.shade),
            Field("Moisture", self.moisture),
            
            Field("Family", self.family),
            Field("USDA hardiness", self.hardiness),
            Field("Known Hazards", self.known_hazards),
            Field("Habitats", self.habitats),
            Field("Range", self.range),
            Field("Edbility Rating", printRating(rating: self.edibility_rating)),
            Field("Other Uses",printRating(rating: self.other_uses_rating)),
            Field("Weed Potential",self.weed_potential),
            Field("Medicinal Rating",printRating(rating: self.medicinal_rating)),
        ]
        return fields.filter { !($0.text.isEmpty) || !($0.uses.isEmpty)}
    }
    
    var detailFields: [Field] {
        let fields =  [
            Field("Summary", self.summary),
            Field("Physical Characteristics", self.physical_characteristics),
            Field("Synonyms", self.synonyms),
            Field("Habitats", self.habitats),
            Field("Edible Uses", self.edible_uses, uses: [
                Uses(name: "Edible Parts", uses: self.findUses(category: "edible parts")),
                Uses(name: "Edible Uses", uses: self.findUses(category: "edible uses"))
            ]),
            Field("Medicinal Uses", self.medicinal_uses, self.findUses(category: ("medicinal uses"))),
            Field("Other Uses", self.other_uses, self.findUses(category: ("other uses"))),
            Field("Special Uses", "", self.findUses(category: ("special uses"))),
            Field("Cultivation details", self.cultivation_details),
            Field("Propagation", self.propagation),
            Field("Other Names", self.other_names),
            Field("Found In", self.found_in),
            Field("Weed Potential", self.weed_potential_section),
            Field("Conservation Status", self.conservation_status),
            Field("Botanical References", self.botanical_references),
            
        ]
        return fields.filter { !($0.text.isEmpty) || !($0.uses.isEmpty)}
    }
    
    func findUses(category: String) -> [String] {
        return self.uses.filter({$0.category == category && $0.name != nil}).map({$0.name!})
    }
    
    
    static let sample = try! JSONDecoder().decode(PFAFPlant.self, from: Data(SAMPLE_ROW.utf8))
    
    
}

func printRating(rating: Double?) -> String {
    if (rating == nil) {
        return ""
    }
    return "\(Int(rating!)) / 5"
}

typealias Response = [PFAFPlant]


let url = URL(string: "https://pfaf-data.herokuapp.com/data-6ea843c.json?sql=select+*+from+plant_data&_shape=array&_json=uses&_json=images&_json=common_names")!


let res = URLSession.shared
    .dataTaskPublisher(for: URLRequest(url: url, cachePolicy: .returnCacheDataElseLoad))
    .tryMap() { element -> Data in
        guard let httpResponse = element.response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        return element.data
    }
    .decode(type: Response.self, decoder: JSONDecoder())
    .receive(on: RunLoop.main)
    .observableObject



// http 'https://pfaf-data.herokuapp.com/data-6ea843c.json?sql=select+*+from+plant_data&_shape=array&_json=uses&_json=images&_json=common_names' | jq .[0]
let SAMPLE_ROW = """
{
  "latin_name": "Abelmoschus esculentus",
  "habit": "Annual",
  "height": 1,
  "hardiness": "5-11",
  "growth": "",
  "soil": "LMH",
  "shade": "N",
  "moisture": "M",
  "edibility_rating": 4,
  "medicinal_rating": 3,
  "other_uses_rating": 2,
  "family": "Malvaceae",
  "known_hazards": "The hairs on the seed pods can be an irritant to some people and gloves should be worn when harvesting. These hairs can be easily removed by washing[200].",
  "habitats": "Not known in a truly wild situation.",
  "range": "The original habitat is obscure.",
  "weed_potential": "Yes",
  "summary": "A perennial, often cultivated as an annual in temperate climates.",
  "physical_characteristics": "Abelmoschus esculentus is a ANNUAL growing to 1 m (3ft 3in).  See above for USDA hardiness. It is hardy to UK zone 8 and is frost tender.  It is in flower from July to September. The species is hermaphrodite (has both male and female organs) and is pollinated by Bees.  Suitable for: light (sandy), medium (loamy) and heavy (clay) soils and prefers  well-drained soil. Suitable pH: mildly acid, neutral and basic (mildly alkaline) soils and can grow in very alkaline soils. It cannot grow in the shade. It prefers  moist soil.",
  "synonyms": "Hibiscus esculentus. L.",
  "habitats_section": "Cultivated Beds;",
  "edible_uses": "Immature fruit - cooked on their own or added to soups etc[2, 27]. They can be used fresh or dried[183]. Mucilaginous[133], they are commonly used as a thickening for soups, stews and sauces[183]. The fruits are rich in pectin and are also a fair source of iron and calcium[240]. The fresh fruits contain 740 iu vitamin A[240]. The fruit should be harvested whilst young, older fruits soon become fibrous[133]. The fruit can be up to 20cm long[200]. Seed - cooked or ground into a meal and used in making bread or made into 'tofu' or 'tempeh'[183]. The roasted seed is a coffee substitute[2, 27, 133]. Probably the best of the coffee substitutes[74]. The seed contains up to 22% of an edible oil[55, 74, 177, 183, 240]. The leaves, flower buds, flowers and calyces can be eaten cooked as greens[183]. The leaves can be dried, crushed into a powder and stored for later use[183]. They are also used as a flavouring[133]. Root - it is edible but very fibrous[144]. Mucilaginous, without very much flavour[144].",
  "medicinal_uses": "The roots are very rich in mucilage, having a strongly demulcent action[4, 21]. They are said by some to be better than marsh mallow (Althaea officinalis)[4]. This mucilage can be used as a plasma replacement[240]. An infusion of the roots is used in the treatment of syphilis[240]. The juice of the roots is used externally in Nepal to treat cuts, wounds and boils[272]. The leaves furnish an emollient poultice[4, 21, 240]. A decoction of the immature capsules is demulcent, diuretic and emollient[240]. It is used in the treatment of catarrhal infections, ardor urinae, dysuria and gonorrhoea[240]. The seeds are antispasmodic, cordial and stimulant[240]. An infusion of the roasted seeds has sudorific properties[240].",
  "other_uses": "A fibre obtained from the stems is used as a substitute for jute[57, 61, 74, 169]. It is also used in making paper and textiles[171]. The fibres are about 2.4mm long[189]. When used for paper the stems are harvested in late summer or autumn after the edible seedpods have been harvested, the leaves are removed and the stems are steamed until the fibres can be stripped off. The fibres are cooked for 2 hours with lye and then put in a ball mill for 3 hours. The paper is cream coloured[189]. A decoction of the root or of the seeds is used as a size for paper[178].",
  "cultivation_details": "Prefers a well-drained humus rich fertile soil in full sun and a pH around 6 to 6.7[200] but it tolerates a wide range of soil types and pH from 5.5 to 8[200]. It prefers a soil with a high potash content[264]. The plant requires a warm sunny position sheltered from winds[200]. It likes plenty of moisture, both in the soil and in the atmosphere[133]. Okra is commonly cultivated in warm temperate and tropical areas for its edible seedpod, there are many named varieties[183, 200]. Most cultivars require about 4 months from sowing before a crop is produced, though some early maturing varieties can produce a crop in 50 days in the tropics[264]. This species is not very hardy in Britain, it sometimes succeeds outdoors in hot summers but is really best grown in a greenhouse since it prefers daytime temperatures of 25°c or more[260]. Plants also dislike low night temperatures[133]. There are some early-maturing varieties that are more tolerant of cooler temperate conditions and these could be tried outdoors[200]. These include 'Clemson's Spineless', 'Emerald Spineless', 'Long Green' and 'Green Velvet'[200]. The flowers are much visited by bees but they may require syringing in order to improve fertilization when plants are grown in a greenhouse. Plants resent being transplanted[133].",
  "propagation": "Seed - sow early spring in a warm greenhouse. The seed germinates in 27 days at 15°c or 6 days at 35°c[133]. When large enough to handle, prick them out into individual pots and plant them out after the last expected frosts[200].",
  "other_names": "A-koto, Angu, Apala, Asowntem, Bakhua-mun, Bamia, Bandakka, Bendi, Bhindee, Bhindi, Binda, Bindi, Bondo, Cantarela, Derere rechipudzi, Derere, Dheras, Dherosh, Enmomi, Fetri, Gombaut, Gombo, Gumbo, Guro, Gusha, Hakuyot, Idelele, Ikhievbo, Ilasha, Ilo, Ka fei huang kui, Kacang bendi, Kaganh lender, Kandia, Kandjie, Kopi arab, Krachiap-mon, Kubewa, Lafeu, Lieka, Loka, Maana, Ma-lontho, Mesta, Muomi, Miagorro, Nathando, Nkruma, Obori, Ochro, Okworu, Okwulu, Otigo-iwoka, Pahari bendi, Pingpesi, Poot barang, Pui, Quiabo, Quimbambo, Saluyot a bunga, Sayur bendi, Taku, Uisul hme, Vandakai, Vandikkai, Vendal, Wayika, You-padi,",
  "found_in": "Africa, Albania, Angola, Antigua and Barbuda, Armenia, Asia, Australia, Bangladesh, Benin, Brazil, Bulgaria, Burkina Faso, Cambodia, Central Africa, Central African Republic, CAR, Central America, China, Congo DR, Cook Islands, Costa Rica, Dominican Republic, East Africa, East Timor, Egypt, Ethiopia, Europe, Fiji, Ghana, Greece, Grenada, Guam, Guyana, Haiti, Hawaii, India, Indochina, Indonesia, Iran, Iraq, Israel, Kazakhstan, Laos, Madagascar, Malawi, Malaysia, Mali, Mexico, Moldova, Mozambique, Nauru, Nepal, Nicaragua, Niger, Nigeria, North Africa, North America, Northeastern India, Pacific, Pakistan, Palestine, Panama, Papua New Guinea, PNG, Philippines, Portugal, Romania, Sao Tome and Principe, SE Asia, Senegal, Sierra Leone, Singapore, Solomon Islands, South Africa, Southern Africa, South America, South Sudan, Spain, Sri Lanka, Sudan, Swaziland, Syria, Tanzania, Thailand, Timor-Leste, Tonga, Trinidad, Turkey, Uganda, Ukraine, USA, Uzbekistan, Vietnam, Venezuela, West Africa, West Indies, Zambia, Zimbabwe.",
  "weed_potential_section": "This plant can be weedy or invasive.",
  "conservation_status": "This taxon has not yet been assessed.",
  "expert_comment": "",
  "author": "(L.)Moench.",
  "botanical_references": "200",
  "common_names": [
    "Okra"
  ],
  "images": [
    {
      "url": "https://pfaf.org/Admin/PlantImages/AbelmoschusEsculentus2.jpg",
      "source": ""
    },
    {
      "url": "https://pfaf.org/Admin/PlantImages/AbelmoschusEsculentus3.jpg",
      "source": ""
    }
  ],
  "uses": [
    {
      "category": "carbon farming",
      "name": "Industrial Crop: Fiber"
    },
    {
      "category": "carbon farming",
      "name": "Management: Coppice"
    },
    {
      "category": "carbon farming",
      "name": "Management: Standard"
    },
    {
      "category": "carbon farming",
      "name": "Regional Crop"
    },
    {
      "category": "carbon farming",
      "name": "Staple Crop: Protein-oil"
    },
    {
      "category": "cultivation",
      "name": "Industrial Crop: Fiber"
    },
    {
      "category": "cultivation",
      "name": "Management: Coppice"
    },
    {
      "category": "cultivation",
      "name": "Management: Standard"
    },
    {
      "category": "cultivation",
      "name": "Regional Crop"
    },
    {
      "category": "cultivation",
      "name": "Staple Crop: Protein-oil"
    },
    {
      "category": "edible parts",
      "name": "Fruit"
    },
    {
      "category": "edible parts",
      "name": "Leaves"
    },
    {
      "category": "edible parts",
      "name": "Oil"
    },
    {
      "category": "edible parts",
      "name": "Root"
    },
    {
      "category": "edible parts",
      "name": "Seed"
    },
    {
      "category": "edible uses",
      "name": "Coffee"
    },
    {
      "category": "edible uses",
      "name": "Oil"
    },
    {
      "category": "edible uses",
      "name": "Pectin"
    },
    {
      "category": "medicinal uses",
      "name": "Antispasmodic"
    },
    {
      "category": "medicinal uses",
      "name": "Demulcent"
    },
    {
      "category": "medicinal uses",
      "name": "Diaphoretic"
    },
    {
      "category": "medicinal uses",
      "name": "Diuretic"
    },
    {
      "category": "medicinal uses",
      "name": "Emollient"
    },
    {
      "category": "medicinal uses",
      "name": "Stimulant"
    },
    {
      "category": "medicinal uses",
      "name": "Vulnerary"
    },
    {
      "category": "other uses",
      "name": "Fibre"
    },
    {
      "category": "other uses",
      "name": "Oil"
    },
    {
      "category": "other uses",
      "name": "Paper"
    },
    {
      "category": "other uses",
      "name": "Pectin"
    },
    {
      "category": "other uses",
      "name": "Size"
    },
    {
      "category": "special uses",
      "name": "Carbon Farming"
    }
  ]
}
"""
