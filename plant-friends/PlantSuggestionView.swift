//
//  PlantSuggestionView.swift
//  plant-friends
//
//  Created by Saul Shanabrook on 5/13/22.
//

import SwiftUI

struct PlantSuggestionView: View {
    var plants: [PFAFPlant]
    var body: some View {
        ForEach(
            plants,
            id: \.self) { plant in
                Text(plant.latin_name).searchCompletion(plant.latin_name)
                ForEach(plant.common_names_not_nil, id: \.self) { common_name in
                    Text(common_name).searchCompletion(common_name)
                }
            }
    }
}

struct PlantSuggestionView_Previews: PreviewProvider {
    static var previews: some View {
        PlantSuggestionView(plants:[PFAFPlant.sample])
    }
}
