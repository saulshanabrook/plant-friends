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
}

struct Use: Hashable, Decodable, Identifiable {
    var category: String?
    var name: String?
    var id: String {
        return String(describing: (self.category, self.name))
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
    //    var habitats: String
    var edible_uses: String
    var medicinal_uses: String
    var other_uses: String
    var cultivation_details: String
    var propagation: String
    var other_names: String
    var found_in: String
    //    var weed_potential: String
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
    
    var common_names_joined: String {
        return self.common_names.compactMap({$0}).joined(separator: ", ")
    }
    
    static let sample = try! JSONDecoder().decode(PFAFPlant.self, from: Data(SAMPLE_ROW.utf8)
    )
}

typealias Response = [PFAFPlant]


let url = URL(string: "https://pfaf-data.herokuapp.com/data.json?sql=select+*+from+plant_data&_shape=array&_json=uses&_json=images&_json=common_names")!


let res = URLSession.shared
    .dataTaskPublisher(for: URLRequest(url: url, cachePolicy: .useProtocolCachePolicy))
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



let SAMPLE_ROW = """
{
  "latin_name": "Abelia triflora",
  "habit": "Shrub",
  "height": 3.5,
  "hardiness": "5-9",
  "growth": "M",
  "soil": "LM",
  "shade": "SN",
  "moisture": "DM",
  "edibility_rating": 0,
  "medicinal_rating": 0,
  "other_uses_rating": 1,
  "family": "Caprifoliaceae",
  "known_hazards": "None known",
  "habitats": "Woodland Garden Sunny Edge; Cultivated Beds;",
  "range": "E. Asia - N.W. Himalayas",
  "weed_potential": "",
  "summary": "",
  "physical_characteristics": "Abelia triflora is a deciduous Shrub growing to 3.5 m (11ft) by 3 m (9ft) at a medium rate.  See above for USDA hardiness. It is hardy to UK zone 6.  It is in flower in June. The species is hermaphrodite (has both male and female organs) and is pollinated by Bees.  Suitable for: light (sandy) and medium (loamy) soils. Suitable pH: neutral and basic (mildly alkaline) soils and can grow in very alkaline soils. It can grow in  semi-shade (light woodland) or no shade. It prefers dry or  moist soil.",
  "synonyms": "Zabelia triflora. (Wallich.)Makino.",
  "edible_uses": "None known",
  "medicinal_uses": "None known",
  "other_uses": "Wood - hard, close and even-grained. Used for walking sticks[146, 158].",
  "cultivation_details": "Requires a well-drained open loamy soil[11] in a warm, sheltered sunny position[200, 245]. Plants are best grown in semi-shade[219]. They are intolerant of water-logging[200] and of dry soils[219]. Succeeds in any soil but new growth is less vigorous in dry soils[202]. One report says that the plant likes a soil with a high chalk content[245], though another says that chlorosis occurs on very alkaline soils[202]. This species is hardy to about -15°c[184], it grows well in the open at Kew[11]. A fairly slow-growing plant, it is shy to flower in British gardens unless placed against a sunny wall[219]. It flowers on wood that is 2 - 3 years old or older[182]. Another report says that the plant flowers on the new wood[219], whilst another says that it flowers on terminal clusters[245]. Any pruning is best done immediately after flowering by thinning out the old wood.[182, 219]. Plants in this genus are notably resistant to honey fungus[200], Closely related to A buddleioides and A. umbellata[182]. The flowers are wonderfully scented[182], with the fragrance of vanilla[245].",
  "propagation": "Seed - we have no specific information for this plant, but suggest sowing the seed in early spring in a greenhouse. When they are large enough to handle, prick the seedlings out into individual pots and grow them on in the greenhouse for at least their first winter. Plant them out into their permanent positions in late spring or early summer, after the last expected frosts. Cuttings of half-ripe wood, 7 -10cm with a slight heel, July in pots of sandy soil in a frame[11]. Takes 3 - 4 weeks. Very easy, a good percentage of the cuttings root[78]. Cuttings of mature wood, 7 - 10cm with a heel if possible, November in a cold frame. High percentage[78]. Layering young shoots[245].",
  "other_names": "",
  "found_in": "",
  "conservation_status": "Least Concern",
  "expert_comment": "",
  "author": "R.Br. ex Wall.",
  "botanical_references": "11200",
  "common_names": [
    "Indian Abelia"
  ],
  "images": [
    {
      "url": "https://pfaf.org/Admin/PlantImages/AbeliaTriflora.jpg",
      "source": ""
    },
    {
      "url": "https://pfaf.org/Admin/PlantImages/AbeliaTriflora2.jpg",
      "source": ""
    }
  ],
  "uses": [
    {
      "category": null,
      "name": null
    }
  ]
}
"""
