//
//  ListView.swift
//  plant-friends
//
//  Created by Saul Shanabrook on 5/13/22.
//

import SwiftUI

struct ListView: View {
    var plants: [PFAFPlant]
    var searchQuery: String
    var body: some View {
        List(plants.filter({plant in
            if (searchQuery == "") {
                return true;
            }
            return plant.latin_name.lowercased().contains(searchQuery.lowercased()) || plant.common_names_not_nil.contains {
                common_name in common_name.lowercased().contains(searchQuery.lowercased())
            }
        })) { plant in
            NavigationLink {
                DetailView(plant: plant)
            } label: {
                VStack(alignment: .leading){
                    Text(plant.latin_name)
                    Text(plant.common_names_joined).font(.subheadline)
                        .fixedSize(horizontal: false, vertical: true)
                        .foregroundColor(.secondary)
                    
                    
                }
            }
        }.navigationTitle("Plants")
    }
}

struct ListView_Previews: PreviewProvider {
    static var previews: some View {
        ListView(plants: [PFAFPlant.sample], searchQuery: "")
    }
}
